from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from csv import DictReader, reader
from json import dumps, loads
from io import StringIO
from collections import deque
from datetime import datetime, timezone
from functools import partial
from pathlib import Path
from threading import Lock
from time import monotonic
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote, urlencode, urlsplit
from urllib.request import Request, urlopen
import re
import os
import sys
import math

AIRLABS_API_KEY = "07ea0ad1-648c-42a6-90d9-8f96583ec58a"
# --- Line 20 ---
# In-memory store for ACARS logs
acars_logs = []

class FlightTrackerHandler(SimpleHTTPRequestHandler):
    airports_cache = None
    airports_lock = Lock()
    airlines_cache = None
    airlines_lock = Lock()
    airlabs_cache = {}
    airlabs_cache_lock = Lock()
    airlabs_data_cache = {}
    airlabs_data_cache_lock = Lock()
    acars_messages = deque(maxlen=300)
    acars_messages_lock = Lock()

    def do_GET(self):
        path = urlsplit(self.path)
        if path.path == "/api/aircraft":
            self._aircraft(parse_qs(path.query))
        elif path.path == "/api/metar":
            self._metar(parse_qs(path.query))
        elif path.path == "/api/airports":
            self._airports(parse_qs(path.query))
        elif path.path == "/api/airport-photo":
            self._airport_photo(parse_qs(path.query))
        elif path.path == "/api/search":
            self._search(parse_qs(path.query))
        elif path.path == "/api/flight-info":
            self._flight_info(parse_qs(path.query))
        elif path.path == "/api/flight-schedule":
            self._flight_schedule(parse_qs(path.query))
        elif path.path == "/api/airport-board":
            self._airport_board(parse_qs(path.query))
        elif path.path == "/api/acars":
            self._get_acars(parse_qs(path.query))
        elif path.path == "/api/airline":
            self._airline(parse_qs(path.query))
        else:
            super().do_GET()
        

    def do_POST(self):
        if urlsplit(self.path).path == "/api/acars":
            self._post_acars()
            return
        self._json_error(404, "Route not found.")

    def _aircraft(self, query):
        try:
            lat = float(query.get("lat", ["40.7128"])[0])
            lon = float(query.get("lon", ["-74.0060"])[0])
            radius = int(query.get("radius", ["40"])[0])
        except ValueError:
            self._json_error(400, "Latitude, longitude, and radius must be numeric.")
            return

        if not -90 <= lat <= 90 or not -180 <= lon <= 180 or not 10 <= radius <= 250:
            self._json_error(400, "Coordinates or radius are outside the supported range.")
            return

        url = f"https://api.adsb.lol/v2/lat/{lat:.4f}/lon/{lon:.4f}/dist/{radius}"
        self._proxy(url)

    def _metar(self, query):
        station = query.get("ids", [""])[0].strip().upper()
        if not re.fullmatch(r"[A-Z0-9]{4}", station):
            self._json_error(400, "Provide a four-character ICAO airport code.")
            return

        url = "https://aviationweather.gov/api/data/metar?" + urlencode({"ids": station, "format": "json"})
        self._proxy(url)

    def _flight_info(self, query):
        hex_code = query.get("hex", [""])[0].strip().upper()
        callsign = query.get("callsign", [""])[0].strip().upper()
        airlines = self._load_airlines() or []

        cache_key = hex_code or callsign
        if not cache_key:
            self._json_error(400, "Provide an aircraft hex address or callsign.")
            return

        now = monotonic()
        with type(self).airlabs_cache_lock:
            cached = type(self).airlabs_cache.get(cache_key)
            if cached and now - cached[0] < 900:
                self._send_json(cached[1])
                return

        api_key = AIRLABS_API_KEY.strip() or os.environ.get("AIRLABS_API_KEY", "").strip()
        flight = None
        schedule_data = None
        schedule_error = ""

        # 1. Try live flight lookup if hex_code is valid
        if re.fullmatch(r"[A-F0-9]{6}", hex_code) and api_key:
            params = urlencode({"hex": hex_code, "api_key": api_key})
            request = Request(
                "https://airlabs.co/api/v9/flights?" + params,
                headers={"Accept": "application/json", "User-Agent": "VectorAirLocal/1.0"},
            )
            try:
                with urlopen(request, timeout=10) as response:
                    payload = loads(response.read())
                    results = payload.get("response", payload) if isinstance(payload, dict) else payload
                    if isinstance(results, dict):
                        results = [results]
                    if isinstance(results, list) and results:
                        flight = next((item for item in results if isinstance(item, dict) and item.get("hex", "").upper() == hex_code), results[0])
            except Exception:
                pass

        # 2. Try schedule lookup
        flight_code = (flight.get("flight_iata") if flight else None) or (flight.get("flight_icao") if flight else None) or callsign
        if flight_code:
            field, code = self._schedule_query(flight_code, airlines)
            if field:
                schedules, schedule_error, _ = self._airlabs_request("schedules", {field: code, "limit": 1}, 900)
                if schedules:
                    schedule_data = schedules[0]

        fields = (
            "hex", "flight_iata", "flight_icao", "flight_number", "airline_iata", "airline_icao",
            "dep_iata", "dep_icao", "arr_iata", "arr_icao", "status", "updated",
        )
        schedule_fields = (
            "flight_iata", "flight_icao", "dep_iata", "dep_icao", "arr_iata", "arr_icao",
            "dep_time", "dep_time_utc", "dep_estimated", "dep_estimated_utc", "dep_actual",
            "dep_actual_utc", "arr_time", "arr_time_utc", "arr_estimated", "arr_estimated_utc",
            "arr_actual", "arr_actual_utc", "dep_gate", "dep_terminal", "arr_gate",
            "arr_terminal", "arr_baggage", "status", "duration", "airline_name"
        )

        res_flight = {}
        if flight:
            res_flight.update({f: flight[f] for f in fields if flight.get(f) is not None})
        if schedule_data:
            res_flight.update({f: schedule_data[f] for f in schedule_fields if schedule_data.get(f) is not None})

        if not res_flight and callsign:
            prefix = re.match(r"^([A-Z]{3})", callsign)
            if prefix:
                match = next((a for a in airlines if a.get("icao") == prefix.group(1)), None)
                if match:
                    res_flight = {
                        "hex": hex_code or "AIR001",
                        "flight_icao": callsign,
                        "flight_iata": (match.get("iata") or "") + callsign[3:],
                        "airline_icao": match.get("icao"),
                        "airline_iata": match.get("iata"),
                        "airline_name": match.get("name"),
                        "status": "en route"
                    }

        if res_flight:
            airline_code = res_flight.get("airline_iata") or res_flight.get("airline_icao")
            if airline_code and not res_flight.get("airline_name"):
                match = next((a for a in airlines if a.get("iata") == airline_code or a.get("icao") == airline_code), None)
                if match:
                    res_flight["airline_name"] = match.get("name")

        result = {"flight": res_flight if res_flight else None}
        if schedule_error and res_flight:
            result["flight"]["schedule_error"] = schedule_error

        with type(self).airlabs_cache_lock:
            type(self).airlabs_cache[cache_key] = (monotonic(), result)
        self._send_json(result)

    def _flight_schedule(self, query):
        term = query.get("flight", [""])[0].strip()
        field, flight_code = self._schedule_query(term, self._load_airlines() or [])
        if not field:
            self._json_error(400, "Enter a flight number such as LH762.")
            return

        schedules, error, status = self._airlabs_request("schedules", {field: flight_code, "limit": 1}, 900)
        if error:
            self._json_error(status, error)
            return
        matching = next((item for item in schedules if item.get(field) == flight_code), None)
        self._send_json({"query": term, "flight": matching})

    def _airport_board(self, query):
        code = query.get("code", [""])[0].strip().upper()
        if not re.fullmatch(r"[A-Z0-9]{3,4}", code):
            self._json_error(400, "Provide a three-letter IATA or four-letter ICAO airport code.")
            return

        code_field = "iata" if len(code) == 3 else "icao"
        departures, departures_error, departures_status = self._airlabs_request(
            "schedules", {f"dep_{code_field}": code, "limit": 50}, 900
        )
        arrivals, arrivals_error, arrivals_status = self._airlabs_request(
            "schedules", {f"arr_{code_field}": code, "limit": 50}, 900
        )
        airport_rows, timezone_error, _ = self._airlabs_request(
            "airports", {f"{code_field}_code": code, "_fields": "iata_code,icao_code,name,timezone"}, 86400
        )
        timezone = airport_rows[0].get("timezone") if airport_rows else None
        if departures_error and arrivals_error:
            status = departures_status if departures_status != 200 else arrivals_status
            self._json_error(status, departures_error)
            return

        self._send_json({
            "airport": code,
            "timezone": timezone,
            "departures": departures[:50],
            "arrivals": arrivals[:50],
            "errors": {"departures": departures_error, "arrivals": arrivals_error},
        })

    def _get_acars(self, query):
        requested_hex = query.get("hex", [""])[0].strip().upper()
        requested_flight = query.get("flight", [""])[0].strip().upper()
        with type(self).acars_messages_lock:
            messages = list(type(self).acars_messages)
        if requested_hex or requested_flight:
            messages = [
                message for message in messages
                if (requested_hex and message["hex"] == requested_hex)
                or (requested_flight and message["flight"].upper() == requested_flight)
            ]
        self._send_json({"messages": messages[-60:]})

    def _post_acars(self):
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._json_error(400, "Invalid content length.")
            return
        if not 1 <= content_length <= 65536:
            self._json_error(413, "ACARS payload must be between 1 and 65,536 bytes.")
            return
        try:
            payload = loads(self.rfile.read(content_length))
        except (ValueError, UnicodeDecodeError):
            self._json_error(400, "ACARS payload must be valid JSON.")
            return

        entries = payload if isinstance(payload, list) else payload.get("messages", [payload]) if isinstance(payload, dict) else []
        accepted = []
        for entry in entries[:50]:
            if not isinstance(entry, dict):
                continue
            text = str(entry.get("message") or entry.get("text") or "").strip()[:4000]
            if not text:
                continue
            accepted.append({
                "flight": str(entry.get("flight") or entry.get("callsign") or "").strip()[:16],
                "hex": str(entry.get("hex") or "").strip().upper()[:6],
                "station": str(entry.get("station") or entry.get("label") or "").strip()[:32],
                "mode": str(entry.get("mode") or "").strip()[:12],
                "frequency": str(entry.get("frequency") or "").strip()[:16],
                "received_at": str(entry.get("received_at") or entry.get("timestamp") or datetime.now(timezone.utc).isoformat())[:40],
                "message": text,
            })
        if not accepted:
            self._json_error(400, "Provide at least one decoded ACARS message in a 'message' or 'text' field.")
            return
        with type(self).acars_messages_lock:
            type(self).acars_messages.extend(accepted)
        self._send_json({"accepted": len(accepted)}, 201)

    def _airlabs_request(self, endpoint, params, cache_seconds):
        api_key = AIRLABS_API_KEY.strip() or os.environ.get("AIRLABS_API_KEY", "").strip()
        if not api_key:
            return None, "AirLabs is not configured. Set AIRLABS_API_KEY on the server.", 503

        cache_key = (endpoint, tuple(sorted((key, str(value)) for key, value in params.items())))
        now = monotonic()
        with type(self).airlabs_data_cache_lock:
            cached = type(self).airlabs_data_cache.get(cache_key)
            if cached and now - cached[0] < cache_seconds:
                return cached[1], "", 200

        request_params = {**params, "api_key": api_key}
        url = "https://airlabs.co/api/v9/" + endpoint + "?" + urlencode(request_params)
        request = Request(url, headers={"Accept": "application/json", "User-Agent": "VectorAirLocal/1.0"})
        try:
            with urlopen(request, timeout=12) as response:
                payload = loads(response.read())
        except HTTPError as error:
            if error.code in {401, 403}:
                return None, "AirLabs rejected the key. Check the key and account quota.", 502
            if error.code == 429:
                return None, "AirLabs request limit reached. Try again after the quota resets.", 429
            return None, f"AirLabs returned HTTP {error.code}.", 502
        except (TimeoutError, URLError, ValueError):
            return None, "Could not reach AirLabs. Try again shortly.", 502

        if isinstance(payload, dict) and payload.get("error"):
            provider_error = payload["error"]
            message = str(provider_error.get("message", "AirLabs could not return schedule data."))[:240]
            error_code = str(provider_error.get("code", ""))
            status = 429 if "limit_exceeded" in error_code else 502
            return None, message, status

        rows = payload.get("response", payload) if isinstance(payload, dict) else payload
        if isinstance(rows, dict):
            rows = [rows]
        if not isinstance(rows, list):
            rows = []
        with type(self).airlabs_data_cache_lock:
            type(self).airlabs_data_cache[cache_key] = (now, rows)
        return rows, "", 200

    @staticmethod
    def _schedule_query(term, airlines):
        compact = re.sub(r"[\s-]+", "", term.upper())
        if re.fullmatch(r"[A-Z0-9]{2}\d{1,5}[A-Z]?", compact):
            return "flight_iata", compact
        if re.fullmatch(r"[A-Z0-9]{3}\d{1,5}[A-Z]?", compact):
            return "flight_icao", compact
        callsign = FlightTrackerHandler._flight_callsign(term, airlines)
        if callsign:
            return "flight_icao", callsign
        return "", ""

    def _airports(self, query):
        code = query.get("code", [""])[0].strip().upper()
        if code:
            airports = self._load_airports()
            if airports is None:
                self._json_error(502, "Could not load the public airport directory.")
                return
            match = next((a for a in airports if a.get("iata") == code or a.get("icao") == code or a.get("id") == code), None)
            self._send_json({"airport": match})
            return

        try:
            south = float(query["south"][0])
            west = float(query["west"][0])
            north = float(query["north"][0])
            east = float(query["east"][0])
        except (KeyError, ValueError, IndexError):
            self._json_error(400, "Provide valid map bounds or a code to find airports.")
            return

        if not (-90 <= south < north <= 90 and -180 <= west <= 180 and -180 <= east <= 180):
            self._json_error(400, "Map bounds are outside the supported range.")
            return
        if north - south > 25 or abs(east - west) > 35:
            self._json_error(400, "Zoom in to search airports in a smaller area.")
            return

        airports = self._load_airports()
        if airports is None:
            self._json_error(502, "Could not load the public airport directory.")
            return

        def in_longitude_range(longitude):
            return west <= longitude <= east if west <= east else longitude >= west or longitude <= east

        results = [airport for airport in airports if south <= airport["lat"] <= north and in_longitude_range(airport["lon"])]
        self._send_json({"airports": results})

    def _airline(self, query):
        code = query.get("code", [""])[0].strip().upper()
        if not code:
            self._json_error(400, "Provide an airline IATA, ICAO, or callsign.")
            return
        airlines = self._load_airlines() or []
        match = next((a for a in airlines if a.get("iata") == code or a.get("icao") == code or a.get("callsign") == code), None)
        self._send_json({"airline": match})

    @staticmethod
    def _interpolate_flight_position(schedule, airports):
        dep_code = (schedule.get("dep_iata") or schedule.get("dep_icao") or "").upper()
        arr_code = (schedule.get("arr_iata") or schedule.get("arr_icao") or "").upper()
        if not dep_code or not arr_code:
            return None

        dep_apt = next((a for a in airports if a.get("iata") == dep_code or a.get("icao") == dep_code or a.get("id") == dep_code), None)
        arr_apt = next((a for a in airports if a.get("iata") == arr_code or a.get("icao") == arr_code or a.get("id") == arr_code), None)
        if not dep_apt or not arr_apt:
            return None

        lat1, lon1 = dep_apt["lat"], dep_apt["lon"]
        lat2, lon2 = arr_apt["lat"], arr_apt["lon"]

        now_ts = datetime.now(timezone.utc).timestamp()
        dep_ts = schedule.get("dep_time_ts") or schedule.get("dep_actual_ts") or schedule.get("dep_estimated_ts")
        arr_ts = schedule.get("arr_time_ts") or schedule.get("arr_estimated_ts")

        fraction = 0.55
        if dep_ts and arr_ts and arr_ts > dep_ts:
            if now_ts < dep_ts:
                fraction = 0.05
            elif now_ts > arr_ts:
                fraction = 0.95
            else:
                fraction = (now_ts - dep_ts) / (arr_ts - dep_ts)
                fraction = max(0.05, min(0.95, fraction))

        phi1, lambda0 = math.radians(lat1), math.radians(lon1)
        phi2, lambda1 = math.radians(lat2), math.radians(lon2)
        d = 2 * math.asin(math.sqrt(math.sin((phi2 - phi1) / 2)**2 + math.cos(phi1) * math.cos(phi2) * math.sin((lambda1 - lambda0) / 2)**2))
        if d == 0:
            cur_lat, cur_lon, bearing = lat1, lon1, 0
        else:
            a = math.sin((1 - fraction) * d) / math.sin(d)
            b = math.sin(fraction * d) / math.sin(d)
            x = a * math.cos(phi1) * math.cos(lambda0) + b * math.cos(phi2) * math.cos(lambda1)
            y = a * math.cos(phi1) * math.sin(lambda0) + b * math.cos(phi2) * math.sin(lambda1)
            z = a * math.sin(phi1) + b * math.sin(phi2)
            phi3 = math.atan2(z, math.sqrt(x**2 + y**2))
            lambda3 = math.atan2(y, x)
            y_b = math.sin(lambda1 - lambda3) * math.cos(phi2)
            x_b = math.cos(phi3) * math.sin(phi2) - math.sin(phi3) * math.cos(phi2) * math.cos(lambda1 - lambda3)
            bearing = (math.degrees(math.atan2(y_b, x_b)) + 360) % 360
            cur_lat, cur_lon = math.degrees(phi3), math.degrees(lambda3)

        flight_code = schedule.get("flight_iata") or schedule.get("flight_icao") or f"FLT{schedule.get('flight_number', '')}"
        callsign = schedule.get("flight_icao") or schedule.get("flight_iata") or flight_code
        hex_id = (re.sub(r'[^A-F0-9]', '', (schedule.get("hex") or callsign).upper()) + "000000")[:6]

        alt = 36000
        if fraction < 0.1:
            alt = int(5000 + fraction * 300000)
        elif fraction > 0.9:
            alt = int(5000 + (1 - fraction) * 300000)

        return {
            "hex": hex_id,
            "flight": flight_code,
            "flight_iata": schedule.get("flight_iata") or flight_code,
            "flight_icao": schedule.get("flight_icao") or callsign,
            "flight_number": schedule.get("flight_number"),
            "r": schedule.get("reg_number") or "N/A",
            "t": schedule.get("aircraft_icao") or "A359",
            "alt_baro": alt,
            "gs": 475,
            "track": round(bearing, 1),
            "lat": round(cur_lat, 4),
            "lon": round(cur_lon, 4),
            "dep_iata": schedule.get("dep_iata"),
            "dep_icao": schedule.get("dep_icao"),
            "arr_iata": schedule.get("arr_iata"),
            "arr_icao": schedule.get("arr_icao"),
            "airline_iata": schedule.get("airline_iata"),
            "airline_icao": schedule.get("airline_icao"),
            "status": schedule.get("status") or "en route",
            "duration": schedule.get("duration"),
            "is_scheduled": True
        }

    def _search(self, query):
        term = query.get("q", [""])[0].strip()[:80]
        if len(term) < 2:
            self._send_json({"airports": [], "airlines": [], "aircraft": [], "scheduled": []})
            return

        airports = self._load_airports() or []
        airlines = self._load_airlines() or []
        airport_matches = self._match_airports(term, airports)
        airline_matches = self._match_airlines(term, airlines)
        scheduled_matches = []
        schedule_error = ""
        schedule_field, flight_code = self._schedule_query(term, airlines)
        if schedule_field:
            schedules, schedule_error, _ = self._airlabs_request(
                "schedules", {schedule_field: flight_code, "limit": 1}, 900
            )
            if schedules:
                matching = next((item for item in schedules if item.get(schedule_field) == flight_code), None)
                if matching:
                    scheduled_matches = [matching]

        aircraft_matches = []
        flight_error = ""
        callsign = self._flight_callsign(term, airlines)
        registration = term.upper().replace(" ", "")

        # 1. Check adsb.lol by callsign / hex / reg
        endpoint = ""
        if callsign:
            endpoint = f"https://api.adsb.lol/v2/callsign/{quote(callsign, safe='')}"
        elif re.fullmatch(r"[A-F0-9]{6}", registration, re.IGNORECASE):
            endpoint = f"https://api.adsb.lol/v2/hex/{quote(registration, safe='')}"
        elif re.fullmatch(r"[A-Z0-9-]{3,12}", registration, re.IGNORECASE):
            endpoint = f"https://api.adsb.lol/v2/reg/{quote(registration, safe='')}"

        if endpoint:
            request = Request(endpoint, headers={"Accept": "application/json", "User-Agent": "VectorAirLocal/1.0"})
            try:
                with urlopen(request, timeout=10) as response:
                    payload = loads(response.read())
                aircraft_matches = [item for item in payload.get("ac", []) if item.get("lat") is not None and item.get("lon") is not None]
            except Exception:
                pass

        # 2. Check AirLabs live flights endpoint
        if not aircraft_matches and (schedule_field or callsign):
            lookup_param = {schedule_field: flight_code} if schedule_field else {"flight_icao": callsign}
            live_flights, _, _ = self._airlabs_request("flights", lookup_param, 60)
            if live_flights:
                for lf in live_flights:
                    lat = lf.get("lat")
                    lon = lf.get("lng") if lf.get("lng") is not None else lf.get("lon")
                    if lat is not None and lon is not None:
                        aircraft_matches.append({
                            "hex": lf.get("hex") or "LIVE01",
                            "flight": lf.get("flight_iata") or lf.get("flight_icao") or flight_code,
                            "flight_iata": lf.get("flight_iata"),
                            "flight_icao": lf.get("flight_icao"),
                            "flight_number": lf.get("flight_number"),
                            "r": lf.get("reg_number") or "",
                            "t": lf.get("aircraft_icao") or "A320",
                            "alt_baro": lf.get("alt"),
                            "gs": lf.get("speed"),
                            "track": lf.get("dir"),
                            "lat": float(lat),
                            "lon": float(lon),
                            "dep_iata": lf.get("dep_iata"),
                            "dep_icao": lf.get("dep_icao"),
                            "arr_iata": lf.get("arr_iata"),
                            "arr_icao": lf.get("arr_icao"),
                            "airline_iata": lf.get("airline_iata"),
                            "airline_icao": lf.get("airline_icao"),
                            "status": lf.get("status") or "active"
                        })

        # 3. If not in live radar, interpolate position from schedule!
        if not aircraft_matches and scheduled_matches:
            interpolated = self._interpolate_flight_position(scheduled_matches[0], airports)
            if interpolated:
                aircraft_matches.append(interpolated)

        self._send_json({
            "query": term,
            "airports": airport_matches,
            "airlines": airline_matches,
            "aircraft": aircraft_matches,
            "scheduled": scheduled_matches,
            "scheduleError": schedule_error,
            "flightError": flight_error,
        })

    @staticmethod
    def _match_airports(term, airports):
        needle = term.casefold()
        matches = []
        for airport in airports:
            codes = [airport.get("iata", ""), airport.get("icao", ""), airport.get("id", "")]
            name = airport.get("name", "").casefold()
            municipality = airport.get("municipality", "").casefold()
            score = 0
            if any(code and code.casefold() == needle for code in codes):
                score = 120
            elif any(code and code.casefold().startswith(needle) for code in codes):
                score = 95
            elif name.startswith(needle):
                score = 80
            elif needle in name:
                score = 65
            elif municipality and needle in municipality:
                score = 45
            if score:
                score += 10 if airport.get("scheduled") else 0
                score += 5 if airport.get("type") == "large_airport" else 0
                matches.append((score, airport))
        matches.sort(key=lambda match: (-match[0], match[1]["name"]))
        return [airport for _, airport in matches[:8]]

    @staticmethod
    def _match_airlines(term, airlines):
        needle = term.casefold()
        matches = []
        for airline in airlines:
            if not airline.get("active"):
                continue
            codes = [airline.get("iata", ""), airline.get("icao", "")]
            name = airline.get("name", "").casefold()
            score = 0
            if any(code and code.casefold() == needle for code in codes):
                score = 120
            elif any(code and code.casefold().startswith(needle) for code in codes):
                score = 95
            elif name == needle:
                score = 90
            elif name.startswith(needle):
                score = 80
            elif needle in name:
                score = 60
            if score:
                matches.append((score, int(airline.get("active", False)), airline))
        matches.sort(key=lambda match: (-match[0], -match[1], match[2]["name"]))
        return [airline for _, _, airline in matches[:6]]

    @staticmethod
    def _flight_callsign(term, airlines):
        compact = re.sub(r"[\s-]+", "", term.upper())
        if re.fullmatch(r"[A-Z0-9]{3,10}", compact):
            for airline in airlines:
                icao = airline.get("icao", "")
                remainder = compact[len(icao):] if icao and compact.startswith(icao) else ""
                if remainder and re.fullmatch(r"\d{1,5}[A-Z]?", remainder):
                    return compact
                iata = airline.get("iata", "")
                remainder = compact[len(iata):] if iata and compact.startswith(iata) else ""
                if icao and remainder and re.fullmatch(r"\d{1,5}[A-Z]?", remainder):
                    return icao + remainder
            if re.fullmatch(r"[A-Z]{3}\d{1,5}[A-Z]?", compact):
                return compact

        flight_number = re.fullmatch(r"(.+?)\s+(\d{1,5}[A-Z]?)", term, re.IGNORECASE)
        if not flight_number:
            return ""
        airline_name, number = flight_number.groups()
        matches = FlightTrackerHandler._match_airlines(airline_name, airlines)
        for airline in matches:
            if airline.get("icao"):
                return airline["icao"] + number.upper()
        return ""

    def _load_airports(self):
        if type(self).airports_cache is not None:
            return type(self).airports_cache

        with type(self).airports_lock:
            if type(self).airports_cache is not None:
                return type(self).airports_cache
            request = Request(
                "https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/airports.csv",
                headers={"User-Agent": "VectorAirLocal/1.0", "Accept": "text/csv"},
            )
            try:
                with urlopen(request, timeout=25) as response:
                    rows = DictReader(StringIO(response.read().decode("utf-8")))
                    airport_types = {"large_airport", "medium_airport", "small_airport", "heliport", "seaplane_base", "balloonport"}
                    type(self).airports_cache = [
                        {
                            "id": row["ident"],
                            "name": row["name"],
                            "type": row["type"],
                            "lat": float(row["latitude_deg"]),
                            "lon": float(row["longitude_deg"]),
                            "elevation": row["elevation_ft"],
                            "municipality": row["municipality"],
                            "country": row["iso_country"],
                            "icao": row["gps_code"],
                            "iata": row["iata_code"],
                            "scheduled": row["scheduled_service"] == "yes",
                            "wikipedia": row["wikipedia_link"],
                        }
                        for row in rows
                        if row["type"] in airport_types and row["latitude_deg"] and row["longitude_deg"]
                    ]
            except (TimeoutError, URLError, UnicodeDecodeError, ValueError):
                return None
        return type(self).airports_cache

    def _load_airlines(self):
        if type(self).airlines_cache is not None:
            return type(self).airlines_cache

        with type(self).airlines_lock:
            if type(self).airlines_cache is not None:
                return type(self).airlines_cache
            request = Request(
                "https://raw.githubusercontent.com/jpatokal/openflights/master/data/airlines.dat",
                headers={"User-Agent": "VectorAirLocal/1.0", "Accept": "text/csv"},
            )
            try:
                with urlopen(request, timeout=15) as response:
                    rows = reader(StringIO(response.read().decode("utf-8")))
                    type(self).airlines_cache = [
                        {
                            "id": row[0],
                            "name": row[1],
                            "iata": "" if row[3] == "\\N" else row[3],
                            "icao": "" if row[4] == "\\N" else row[4],
                            "callsign": "" if row[5] == "\\N" else row[5],
                            "country": "" if row[6] == "\\N" else row[6],
                            "active": row[7] == "Y",
                        }
                        for row in rows
                        if len(row) >= 8 and row[1] and row[1] != "\\N"
                    ]
            except (TimeoutError, URLError, UnicodeDecodeError, ValueError, IndexError):
                return None
        return type(self).airlines_cache

    def _airport_photo(self, query):
        wikipedia_link = query.get("wikipedia", [""])[0]
        airport_name = query.get("name", [""])[0][:120]
        article_title = ""
        if wikipedia_link.startswith("https://en.wikipedia.org/wiki/"):
            article_title = urlsplit(wikipedia_link).path.rsplit("/wiki/", 1)[-1]
        if not article_title:
            article_title = airport_name
        if not article_title:
            self._json_error(400, "Provide an airport article or name.")
            return

        params = urlencode({
            "action": "query",
            "prop": "pageimages",
            "piprop": "thumbnail",
            "pithumbsize": "800",
            "titles": article_title,
            "format": "json",
        })
        request = Request(
            "https://en.wikipedia.org/w/api.php?" + params,
            headers={"User-Agent": "VectorAirLocal/1.0 (airport photo lookup)", "Accept": "application/json"},
        )
        try:
            with urlopen(request, timeout=15) as response:
                payload = loads(response.read())
        except (TimeoutError, URLError, ValueError):
            self._json_error(502, "Could not load an airport photo.")
            return

        pages = payload.get("query", {}).get("pages", {}).values()
        page = next(iter(pages), {})
        image_url = page.get("thumbnail", {}).get("source", "")
        if image_url and not image_url.startswith("https://"):
            image_url = ""
        self._send_json({"image": image_url, "title": page.get("title", airport_name), "article": wikipedia_link})

    def _send_json(self, payload, status=200):
        body = dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _proxy(self, url):
        request = Request(url, headers={"Accept": "application/json", "User-Agent": "VectorAirLocal/1.0"})
        try:
            with urlopen(request, timeout=15) as response:
                body = response.read()
                status = response.status
                content_type = response.headers.get("Content-Type", "application/json")
        except HTTPError as error:
            self._json_error(502, f"Aviation data provider returned HTTP {error.code}.")
            return
        except (TimeoutError, URLError) as error:
            self._json_error(502, "Could not reach the aviation data provider.")
            return

        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json_error(self, status, message):
        body = dumps({"error": message}).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    requested_port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    project_directory = Path(__file__).resolve().parent
    ports = [requested_port] if len(sys.argv) > 1 else range(requested_port, requested_port + 10)
    server = None
    port = requested_port
    for port in ports:
        try:
            handler = partial(FlightTrackerHandler, directory=str(project_directory))
            server = ThreadingHTTPServer(("127.0.0.1", port), handler)
            break
        except OSError as error:
            address_in_use = error.errno in {98, 10048} or getattr(error, "winerror", None) == 10048
            if len(sys.argv) > 1 or not address_in_use:
                raise SystemExit(f"Could not start Vector Air on port {port}: {error}") from error

    if server is None:
        raise SystemExit(f"Could not find an open port between {requested_port} and {requested_port + 9}.")

    print(f"Vector Air is running at http://127.0.0.1:{port}/flighttracker.html")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping Vector Air.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
