//! Anchoring to the real world through OpenStreetMap: place names to coordinates (and back) with
//! a Nominatim geocoder. Nominatim's public instance asks for an identifying User-Agent, at most
//! one request a second, and caching of results - all done here; point `endpoint` at your own
//! instance for heavier use. Results are © OpenStreetMap contributors (ODbL).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

pub const USER_AGENT: &str = "EntropyEngine-QuadPlanet/0.1 (+https://github.com/alexthegoodman/entropy-engine)";
pub const NOMINATIM: &str = "https://nominatim.openstreetmap.org";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Place {
    pub name: String,
    pub lat: f64,
    pub lon: f64,
    /// OSM class/type, e.g. "natural/peak".
    #[serde(default)]
    pub kind: String,
}

#[derive(Deserialize)]
struct NominatimHit {
    lat: String,
    lon: String,
    display_name: String,
    #[serde(default)]
    category: Option<String>,
    #[serde(default, rename = "class")]
    class: Option<String>,
    #[serde(default, rename = "type")]
    kind: Option<String>,
}

#[derive(Deserialize)]
struct NominatimReverse {
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    error: Option<String>,
}

/// Turns Nominatim's search JSON into places.
pub fn parse_search(json: &str) -> Result<Vec<Place>, String> {
    let hits: Vec<NominatimHit> = serde_json::from_str(json).map_err(|e| format!("unexpected geocoder reply: {e}"))?;
    Ok(hits.into_iter().filter_map(|h| {
        let class = h.category.or(h.class).unwrap_or_default();
        Some(Place { lat: h.lat.parse().ok()?, lon: h.lon.parse().ok()?, name: h.display_name, kind: format!("{class}/{}", h.kind.unwrap_or_default()) })
    }).collect())
}

struct State {
    last_request: Option<Instant>,
    search_cache: HashMap<String, Vec<Place>>,
    /// Reverse lookups by a ~1 km grid cell.
    reverse_cache: HashMap<(i64, i64), Option<String>>,
    reverse_in_flight: Option<(i64, i64)>,
}

pub struct Geocoder {
    endpoint: String,
    state: Arc<Mutex<State>>,
}

impl Geocoder {
    pub fn new(endpoint: Option<String>) -> Self {
        Self {
            endpoint: endpoint.unwrap_or_else(|| NOMINATIM.to_string()).trim_end_matches('/').to_string(),
            state: Arc::new(Mutex::new(State { last_request: None, search_cache: HashMap::new(), reverse_cache: HashMap::new(), reverse_in_flight: None })),
        }
    }

    /// Places matching `query`, best first (blocks for the request; cached).
    pub fn search(&self, query: &str) -> Result<Vec<Place>, String> {
        let key = query.trim().to_lowercase();
        if let Some(hit) = self.state.lock().unwrap().search_cache.get(&key) { return Ok(hit.clone()); }
        let url = format!("{}/search?format=jsonv2&limit=5&q={}", self.endpoint, url::form_urlencoded::byte_serialize(query.as_bytes()).collect::<String>());
        let state = self.state.clone();
        let text = std::thread::spawn(move || throttled_get(&state, &url)).join().map_err(|_| "geocoder thread panicked".to_string())??;
        let places = parse_search(&text)?;
        self.state.lock().unwrap().search_cache.insert(key, places.clone());
        Ok(places)
    }

    /// The name of the place at a coordinate if known, starting a lookup in the background if
    /// not (poll again later). At most one lookup runs at a time.
    pub fn reverse(&self, lat: f64, lon: f64) -> Option<String> {
        let cell = ((lat * 100.0).round() as i64, (lon * 100.0).round() as i64);
        let mut st = self.state.lock().unwrap();
        if let Some(hit) = st.reverse_cache.get(&cell) { return hit.clone(); }
        if st.reverse_in_flight.is_some() { return None; }
        st.reverse_in_flight = Some(cell);
        drop(st);
        let url = format!("{}/reverse?format=jsonv2&zoom=10&lat={lat:.5}&lon={lon:.5}", self.endpoint);
        let state = self.state.clone();
        std::thread::spawn(move || {
            let name = throttled_get(&state, &url).ok()
                .and_then(|t| serde_json::from_str::<NominatimReverse>(&t).ok())
                .and_then(|r| if r.error.is_some() { None } else { r.display_name });
            let mut st = state.lock().unwrap();
            st.reverse_cache.insert(cell, name);
            st.reverse_in_flight = None;
        });
        None
    }
}

fn throttled_get(state: &Arc<Mutex<State>>, url: &str) -> Result<String, String> {
    // One request a second, as the public Nominatim asks.
    loop {
        let wait = {
            let mut st = state.lock().unwrap();
            match st.last_request {
                Some(t) if t.elapsed() < Duration::from_secs(1) => Some(Duration::from_secs(1) - t.elapsed()),
                _ => { st.last_request = Some(Instant::now()); None }
            }
        };
        match wait { Some(w) => std::thread::sleep(w), None => break }
    }
    reqwest::blocking::Client::builder().user_agent(USER_AGENT).timeout(Duration::from_secs(10)).build()
        .and_then(|c| c.get(url).send())
        .and_then(|r| r.error_for_status())
        .and_then(|r| r.text())
        .map_err(|e| format!("geocoder request failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_nominatim_search_results() {
        let json = r#"[{"place_id":1,"lat":"27.9881206","lon":"86.9249751","category":"natural","type":"peak","display_name":"Mount Everest, Nepal"}]"#;
        let places = parse_search(json).unwrap();
        assert_eq!(places.len(), 1);
        assert_eq!(places[0].name, "Mount Everest, Nepal");
        assert!((places[0].lat - 27.9881206).abs() < 1e-9 && (places[0].lon - 86.9249751).abs() < 1e-9);
        assert_eq!(places[0].kind, "natural/peak");
        assert!(parse_search("{\"error\":1}").is_err());
    }
}
