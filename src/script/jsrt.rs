//! JavaScript semantics for Rhai: what a script translated from TypeScript (see
//! `scripts/ts2rhai.mjs`) runs on.
//!
//! Rhai values are copied on assignment; JavaScript objects and arrays are shared references, and
//! game code leans on that everywhere (`const p = this.player; p.pos = ...`). So translated code
//! builds its objects and arrays as these reference types instead of Rhai maps and arrays:
//!
//! - [`Obj`]: an object. Properties are read and written with `.name` (Rhai falls back to the
//!   string indexer registered here) and keep insertion order like JavaScript's.
//! - [`List`]: an array, with the JavaScript methods translated code calls (`push`, `js_map1`,
//!   `js_filter1`, `slice`, ...). Callback methods carry the callback's arity in their name, as
//!   Rhai calls a function pointer with exactly the arguments given.
//! - [`JsMap`] / [`JsSet`]: `Map` and `Set`, keyed by value for strings and numbers and by
//!   identity for objects.
//!
//! Plus the operators JavaScript has and Rhai lacks: truthiness (`truthy`), loose identity
//! (`js_eq`), JavaScript number formatting (`js_str`), `typeof`, `Math.*`, string methods,
//! a few regular expressions, and JSON that builds these types.

use std::cell::RefCell;
use std::rc::Rc;

/// Insertion-ordered, with a fast hash: property names are short and come from the script itself.
type IndexMap<K, V> = indexmap::IndexMap<K, V, std::hash::BuildHasherDefault<rustc_hash::FxHasher>>;
use rhai::{Array, Dynamic, Engine, EvalAltResult, FnPtr, ImmutableString, Map, NativeCallContext, FLOAT, INT};

pub type RResult<T> = Result<T, Box<EvalAltResult>>;

#[derive(Clone, Default)]
pub struct Obj(pub Rc<RefCell<IndexMap<ImmutableString, Dynamic>>>);

#[derive(Clone, Default)]
pub struct List(pub Rc<RefCell<Vec<Dynamic>>>);

#[derive(Clone, Default)]
pub struct JsMap(pub Rc<RefCell<IndexMap<String, (Dynamic, Dynamic)>>>);

#[derive(Clone, Default)]
pub struct JsSet(pub Rc<RefCell<IndexMap<String, Dynamic>>>);

impl Obj {
    pub fn from_map(m: Map) -> Self {
        Obj(Rc::new(RefCell::new(m.into_iter().map(|(k, v)| (ImmutableString::from(k.as_str()), v)).collect())))
    }
    pub fn get(&self, k: &str) -> Dynamic {
        self.0.borrow().get(k).cloned().unwrap_or(Dynamic::UNIT)
    }
    pub fn set(&self, k: impl Into<ImmutableString>, v: Dynamic) {
        self.0.borrow_mut().insert(k.into(), v);
    }
}

impl List {
    pub fn new(v: Vec<Dynamic>) -> Self {
        List(Rc::new(RefCell::new(v)))
    }
}

impl IntoIterator for List {
    type Item = Dynamic;
    type IntoIter = std::vec::IntoIter<Dynamic>;
    fn into_iter(self) -> Self::IntoIter {
        self.0.borrow().clone().into_iter()
    }
}

impl IntoIterator for JsSet {
    type Item = Dynamic;
    type IntoIter = std::vec::IntoIter<Dynamic>;
    fn into_iter(self) -> Self::IntoIter {
        self.0.borrow().values().cloned().collect::<Vec<_>>().into_iter()
    }
}

impl IntoIterator for JsMap {
    type Item = Dynamic;
    type IntoIter = std::vec::IntoIter<Dynamic>;
    /// `for (const [k, v] of map)`: each entry a two-element list.
    fn into_iter(self) -> Self::IntoIter {
        self.0.borrow().values().map(|(k, v)| Dynamic::from(List::new(vec![k.clone(), v.clone()]))).collect::<Vec<_>>().into_iter()
    }
}

/// The number in a value (`Number(x)` for numbers, booleans and numeric strings), NaN otherwise.
pub fn num(d: &Dynamic) -> f64 {
    if let Ok(f) = d.as_float() {
        f
    } else if let Ok(i) = d.as_int() {
        i as f64
    } else if let Ok(b) = d.as_bool() {
        if b { 1.0 } else { 0.0 }
    } else if d.is_unit() {
        f64::NAN
    } else if let Some(s) = d.read_lock::<ImmutableString>() {
        let t = s.trim();
        if t.is_empty() { 0.0 } else { t.parse().unwrap_or(f64::NAN) }
    } else {
        f64::NAN
    }
}

pub fn truthy(d: &Dynamic) -> bool {
    if d.is_unit() {
        return false;
    }
    if let Ok(b) = d.as_bool() {
        return b;
    }
    if let Ok(f) = d.as_float() {
        return f != 0.0 && !f.is_nan();
    }
    if let Ok(i) = d.as_int() {
        return i != 0;
    }
    if let Some(s) = d.read_lock::<ImmutableString>() {
        return !s.is_empty();
    }
    true
}

/// JavaScript's `String(n)` for a number: integers without a decimal point, NaN and Infinity by name.
pub fn fmt_num(f: f64) -> String {
    if f.is_nan() {
        "NaN".into()
    } else if f.is_infinite() || f.abs() == f64::MAX {
        if f > 0.0 { "Infinity".into() } else { "-Infinity".into() }
    } else if f == 0.0 {
        "0".into()
    } else if f.abs() >= 1e21 || f.abs() < 1e-6 {
        // JavaScript switches to exponent form here; Rust's {:e} is close enough ("1e21").
        let s = format!("{f:e}");
        s.replace("e", "e+").replace("e+-", "e-")
    } else {
        format!("{f}")
    }
}

pub fn js_str(d: &Dynamic) -> String {
    if d.is_unit() {
        return "undefined".into();
    }
    if let Ok(f) = d.as_float() {
        return fmt_num(f);
    }
    if let Ok(i) = d.as_int() {
        return i.to_string();
    }
    if let Ok(b) = d.as_bool() {
        return b.to_string();
    }
    if let Some(s) = d.read_lock::<ImmutableString>() {
        return s.to_string();
    }
    if let Some(l) = d.read_lock::<List>() {
        return l.0.borrow().iter().map(|x| if x.is_unit() { String::new() } else { js_str(x) }).collect::<Vec<_>>().join(",");
    }
    if d.is::<Obj>() {
        return "[object Object]".into();
    }
    d.to_string()
}

fn key_of(d: &Dynamic) -> String {
    if let Some(s) = d.read_lock::<ImmutableString>() {
        return format!("s:{}", s.as_str());
    }
    if d.is_float() || d.is_int() {
        return format!("n:{}", fmt_num(num(d)));
    }
    if let Ok(b) = d.as_bool() {
        return format!("b:{b}");
    }
    if d.is_unit() {
        return "u".into();
    }
    if let Some(o) = d.read_lock::<Obj>() {
        return format!("o:{:p}", Rc::as_ptr(&o.0));
    }
    if let Some(o) = d.read_lock::<List>() {
        return format!("l:{:p}", Rc::as_ptr(&o.0));
    }
    format!("?:{d}")
}

/// `===`: numbers and strings by value, objects by identity.
pub fn js_eq(a: &Dynamic, b: &Dynamic) -> bool {
    if (a.is_float() || a.is_int()) && (b.is_float() || b.is_int()) {
        return num(a) == num(b);
    }
    if a.is_unit() || b.is_unit() {
        return a.is_unit() && b.is_unit();
    }
    if let (Some(x), Some(y)) = (a.read_lock::<ImmutableString>(), b.read_lock::<ImmutableString>()) {
        return *x == *y;
    }
    if let (Ok(x), Ok(y)) = (a.as_bool(), b.as_bool()) {
        return x == y;
    }
    if let (Some(x), Some(y)) = (a.read_lock::<Obj>(), b.read_lock::<Obj>()) {
        return Rc::ptr_eq(&x.0, &y.0);
    }
    if let (Some(x), Some(y)) = (a.read_lock::<List>(), b.read_lock::<List>()) {
        return Rc::ptr_eq(&x.0, &y.0);
    }
    if let (Some(x), Some(y)) = (a.read_lock::<JsMap>(), b.read_lock::<JsMap>()) {
        return Rc::ptr_eq(&x.0, &y.0);
    }
    if let (Some(x), Some(y)) = (a.read_lock::<JsSet>(), b.read_lock::<JsSet>()) {
        return Rc::ptr_eq(&x.0, &y.0);
    }
    false
}

pub fn js_typeof(d: &Dynamic) -> &'static str {
    if d.is_unit() {
        "undefined"
    } else if d.is_float() || d.is_int() {
        "number"
    } else if d.is_bool() {
        "boolean"
    } else if d.is_string() {
        "string"
    } else if d.is::<FnPtr>() {
        "function"
    } else {
        "object"
    }
}

fn idx(i: f64, len: usize) -> Option<usize> {
    if i.is_nan() || i < 0.0 || i.fract() != 0.0 {
        return None;
    }
    let i = i as usize;
    if i < len { Some(i) } else { None }
}

/// `slice`/`substring`-style bounds: negatives count from the end.
fn bounds(len: usize, a: Option<f64>, b: Option<f64>) -> (usize, usize) {
    let n = len as f64;
    let fix = |x: f64| -> usize {
        let x = if x.is_nan() { 0.0 } else { x.trunc() };
        (if x < 0.0 { (n + x).max(0.0) } else { x.min(n) }) as usize
    };
    let s = a.map(fix).unwrap_or(0);
    let e = b.map(fix).unwrap_or(len);
    (s, e.max(s))
}

fn call(ctx: &NativeCallContext, f: &FnPtr, args: Vec<Dynamic>) -> RResult<Dynamic> {
    f.call_raw(ctx, None, args)
}

fn to_json_value(d: &Dynamic, depth: usize) -> serde_json::Value {
    use serde_json::Value;
    if depth > 64 {
        return Value::Null;
    }
    if d.is_unit() {
        return Value::Null;
    }
    if let Ok(f) = d.as_float() {
        return if f.is_finite() {
            if f.fract() == 0.0 && f.abs() < 9e15 { Value::from(f as i64) } else { serde_json::Number::from_f64(f).map(Value::Number).unwrap_or(Value::Null) }
        } else {
            Value::Null
        };
    }
    if let Ok(i) = d.as_int() {
        return Value::from(i);
    }
    if let Ok(b) = d.as_bool() {
        return Value::Bool(b);
    }
    if let Some(s) = d.read_lock::<ImmutableString>() {
        return Value::String(s.to_string());
    }
    if let Some(l) = d.read_lock::<List>() {
        return Value::Array(l.0.borrow().iter().map(|x| to_json_value(x, depth + 1)).collect());
    }
    if let Some(o) = d.read_lock::<Obj>() {
        let mut m = serde_json::Map::new();
        for (k, v) in o.0.borrow().iter() {
            // JSON.stringify leaves out undefined and functions.
            if v.is_unit() || v.is::<FnPtr>() {
                continue;
            }
            m.insert(k.to_string(), to_json_value(v, depth + 1));
        }
        return Value::Object(m);
    }
    if let Some(a) = d.read_lock::<Array>() {
        return Value::Array(a.iter().map(|x| to_json_value(x, depth + 1)).collect());
    }
    if let Some(m) = d.read_lock::<Map>() {
        return Value::Object(m.iter().filter(|(_, v)| !v.is_unit()).map(|(k, v)| (k.to_string(), to_json_value(v, depth + 1))).collect());
    }
    if let Some(f) = d.read_lock::<super::rmath::Floats>() {
        return Value::Array(f.0.borrow().iter().map(|x| serde_json::Number::from_f64(*x as f64).map(Value::Number).unwrap_or(Value::Null)).collect());
    }
    Value::Null
}

/// JSON value -> `Obj`/`List`/numbers (always FLOAT, as JavaScript has one number type).
pub fn from_json_value(v: &serde_json::Value) -> Dynamic {
    use serde_json::Value;
    match v {
        Value::Null => Dynamic::UNIT,
        Value::Bool(b) => (*b).into(),
        Value::Number(n) => Dynamic::from_float(n.as_f64().unwrap_or(0.0)),
        Value::String(s) => s.clone().into(),
        Value::Array(a) => Dynamic::from(List::new(a.iter().map(from_json_value).collect())),
        Value::Object(m) => {
            let o = Obj::default();
            for (k, v) in m {
                o.set(k.as_str(), from_json_value(v));
            }
            Dynamic::from(o)
        }
    }
}

pub fn to_json(d: &Dynamic) -> serde_json::Value {
    to_json_value(d, 0)
}

/// `Obj`/`List` -> plain Rhai maps and arrays (for the engine API, which reads those).
pub fn plain(d: &Dynamic) -> Dynamic {
    if let Some(o) = d.read_lock::<Obj>() {
        let mut m = Map::new();
        for (k, v) in o.0.borrow().iter() {
            m.insert(k.as_str().into(), plain(v));
        }
        return m.into();
    }
    if let Some(l) = d.read_lock::<List>() {
        return Dynamic::from_array(l.0.borrow().iter().map(plain).collect());
    }
    if let Some(m) = d.read_lock::<Map>() {
        let mut out = Map::new();
        for (k, v) in m.iter() {
            out.insert(k.clone(), plain(v));
        }
        return out.into();
    }
    if let Some(a) = d.read_lock::<Array>() {
        return Dynamic::from_array(a.iter().map(plain).collect());
    }
    d.clone()
}

fn round_js(x: f64) -> f64 {
    (x + 0.5).floor()
}

fn list_of_strings(v: Vec<String>) -> List {
    List::new(v.into_iter().map(Dynamic::from).collect())
}

fn sort_list(ctx: &NativeCallContext, l: &List, f: Option<FnPtr>) -> RResult<()> {
    let mut items = l.0.borrow().clone();
    let mut err = None;
    match f {
        Some(f) => items.sort_by(|a, b| {
            if err.is_some() {
                return std::cmp::Ordering::Equal;
            }
            match call(ctx, &f, vec![a.clone(), b.clone()]) {
                Ok(r) => num(&r).partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal),
                Err(e) => {
                    err = Some(e);
                    std::cmp::Ordering::Equal
                }
            }
        }),
        None => items.sort_by_key(js_str),
    }
    if let Some(e) = err {
        return Err(e);
    }
    *l.0.borrow_mut() = items;
    Ok(())
}

pub fn register(engine: &mut Engine) {
    // --- Obj ---
    engine.register_type_with_name::<Obj>("Obj");
    engine.register_fn("obj", Obj::from_map);
    engine.register_fn("obj", || Obj::default());
    // An object literal in source order: keys, then a map of the values.
    engine.register_fn("obj_o", |keys: Array, m: Map| {
        let o = Obj::default();
        for k in keys {
            let k = k.into_immutable_string().unwrap_or_default();
            o.set(k.clone(), m.get(k.as_str()).cloned().unwrap_or(Dynamic::UNIT));
        }
        o
    });
    engine.register_indexer_get(|o: &mut Obj, k: ImmutableString| o.get(&k));
    engine.register_indexer_set(|o: &mut Obj, k: ImmutableString, v: Dynamic| o.set(k, v));
    // Record<number, T>: numeric keys are their JavaScript strings.
    engine.register_indexer_get(|o: &mut Obj, k: FLOAT| o.get(&fmt_num(k)));
    engine.register_indexer_set(|o: &mut Obj, k: FLOAT, v: Dynamic| o.set(fmt_num(k), v));
    engine.register_fn("js_keys", |o: Obj| list_of_strings(o.0.borrow().keys().map(|k| k.to_string()).collect()));
    engine.register_fn("js_values", |o: Obj| List::new(o.0.borrow().values().cloned().collect()));
    engine.register_fn("js_entries", |o: Obj| List::new(o.0.borrow().iter().map(|(k, v)| Dynamic::from(List::new(vec![k.clone().into(), v.clone()]))).collect()));
    engine.register_fn("js_has", |o: Obj, k: ImmutableString| o.0.borrow().contains_key(&k));
    engine.register_fn("js_has", |o: Dynamic, k: ImmutableString| o.read_lock::<Obj>().map(|o| o.0.borrow().contains_key(&k)).unwrap_or(false));
    engine.register_fn("js_omit", |o: Obj, keys: Array| {
        let skip: Vec<String> = keys.into_iter().map(|k| js_str(&k)).collect();
        let out = Obj::default();
        for (k, v) in o.0.borrow().iter() {
            if !skip.iter().any(|s| s == k.as_str()) {
                out.set(k.clone(), v.clone());
            }
        }
        out
    });
    engine.register_fn("js_delete", |o: Obj, k: ImmutableString| o.0.borrow_mut().shift_remove(&k).is_some());
    engine.register_fn("js_assign", |t: Obj, s: Dynamic| {
        if let Some(src) = s.read_lock::<Obj>() {
            let items: Vec<_> = src.0.borrow().iter().map(|(k, v)| (k.clone(), v.clone())).collect();
            for (k, v) in items {
                t.set(k, v);
            }
        }
        t
    });
    // {...a, b: 1, ...c}: parts are objects (spread) or maps of literal fields, in order.
    engine.register_fn("js_merge", |parts: Array| {
        let o = Obj::default();
        for p in parts {
            if let Some(src) = p.read_lock::<Obj>() {
                for (k, v) in src.0.borrow().iter() {
                    o.set(k.clone(), v.clone());
                }
            } else if let Some(m) = p.read_lock::<Map>() {
                for (k, v) in m.iter() {
                    o.set(k.as_str(), v.clone());
                }
            }
        }
        o
    });

    // --- List ---
    engine.register_type_with_name::<List>("List");
    engine.register_iterator::<List>();
    engine.register_fn("list", List::new);
    engine.register_fn("list", || List::default());
    engine.register_get("length", |l: &mut List| l.0.borrow().len() as FLOAT);
    engine.register_set("length", |l: &mut List, n: FLOAT| l.0.borrow_mut().resize(n.max(0.0) as usize, Dynamic::UNIT));
    engine.register_indexer_get(|l: &mut List, i: FLOAT| l.0.borrow().get(idx(i, usize::MAX).unwrap_or(usize::MAX)).cloned().unwrap_or(Dynamic::UNIT));
    engine.register_indexer_get(|l: &mut List, i: INT| l.0.borrow().get(i.max(0) as usize).cloned().unwrap_or(Dynamic::UNIT));
    engine.register_indexer_set(|l: &mut List, i: FLOAT, v: Dynamic| {
        if let Some(i) = idx(i, usize::MAX) {
            let mut v_ = l.0.borrow_mut();
            if i >= v_.len() {
                v_.resize(i + 1, Dynamic::UNIT);
            }
            v_[i] = v;
        }
    });
    engine.register_indexer_set(|l: &mut List, i: INT, v: Dynamic| {
        let i = i.max(0) as usize;
        let mut v_ = l.0.borrow_mut();
        if i >= v_.len() {
            v_.resize(i + 1, Dynamic::UNIT);
        }
        v_[i] = v;
    });
    engine.register_fn("push", |l: &mut List, v: Dynamic| {
        let mut v_ = l.0.borrow_mut();
        v_.push(v);
        v_.len() as FLOAT
    });
    engine.register_fn("push", |l: &mut List, a: Dynamic, b: Dynamic| {
        let mut v_ = l.0.borrow_mut();
        v_.push(a);
        v_.push(b);
        v_.len() as FLOAT
    });
    engine.register_fn("push", |l: &mut List, a: Dynamic, b: Dynamic, c: Dynamic| {
        let mut v_ = l.0.borrow_mut();
        v_.extend([a, b, c]);
        v_.len() as FLOAT
    });
    engine.register_fn("push", |l: &mut List, a: Dynamic, b: Dynamic, c: Dynamic, d: Dynamic| {
        let mut v_ = l.0.borrow_mut();
        v_.extend([a, b, c, d]);
        v_.len() as FLOAT
    });
    engine.register_fn("pop", |l: &mut List| l.0.borrow_mut().pop().unwrap_or(Dynamic::UNIT));
    engine.register_fn("shift", |l: &mut List| {
        let mut v = l.0.borrow_mut();
        if v.is_empty() { Dynamic::UNIT } else { v.remove(0) }
    });
    engine.register_fn("unshift", |l: &mut List, x: Dynamic| {
        let mut v = l.0.borrow_mut();
        v.insert(0, x);
        v.len() as FLOAT
    });
    engine.register_fn("includes", |l: &mut List, x: Dynamic| l.0.borrow().iter().any(|e| js_eq(e, &x)));
    engine.register_fn("indexOf", |l: &mut List, x: Dynamic| l.0.borrow().iter().position(|e| js_eq(e, &x)).map(|i| i as FLOAT).unwrap_or(-1.0));
    engine.register_fn("slice", |l: &mut List| List::new(l.0.borrow().clone()));
    engine.register_fn("slice", |l: &mut List, a: FLOAT| {
        let v = l.0.borrow();
        let (s, e) = bounds(v.len(), Some(a), None);
        List::new(v[s..e].to_vec())
    });
    engine.register_fn("slice", |l: &mut List, a: FLOAT, b: FLOAT| {
        let v = l.0.borrow();
        let (s, e) = bounds(v.len(), Some(a), Some(b));
        List::new(v[s..e].to_vec())
    });
    engine.register_fn("splice", |l: &mut List, start: FLOAT, count: FLOAT| {
        let mut v = l.0.borrow_mut();
        let (s, _) = bounds(v.len(), Some(start), None);
        let e = (s + count.max(0.0) as usize).min(v.len());
        List::new(v.drain(s..e).collect())
    });
    engine.register_fn("splice", |l: &mut List, start: FLOAT, count: FLOAT, item: Dynamic| {
        let mut v = l.0.borrow_mut();
        let (s, _) = bounds(v.len(), Some(start), None);
        let e = (s + count.max(0.0) as usize).min(v.len());
        let out: Vec<_> = v.drain(s..e).collect();
        v.insert(s, item);
        List::new(out)
    });
    engine.register_fn("concat", |l: &mut List, other: List| {
        let mut v = l.0.borrow().clone();
        v.extend(other.0.borrow().iter().cloned());
        List::new(v)
    });
    engine.register_fn("join", |l: &mut List, sep: ImmutableString| l.0.borrow().iter().map(|x| if x.is_unit() { String::new() } else { js_str(x) }).collect::<Vec<_>>().join(sep.as_str()));
    engine.register_fn("join", |l: &mut List| l.0.borrow().iter().map(js_str).collect::<Vec<_>>().join(","));
    engine.register_fn("reverse", |l: &mut List| {
        l.0.borrow_mut().reverse();
        l.clone()
    });
    engine.register_fn("fill", |l: &mut List, x: Dynamic| {
        l.0.borrow_mut().iter_mut().for_each(|e| *e = x.clone());
        l.clone()
    });
    engine.register_fn("js_sort", |ctx: NativeCallContext, l: &mut List, f: FnPtr| -> RResult<List> {
        sort_list(&ctx, l, Some(f))?;
        Ok(l.clone())
    });
    engine.register_fn("js_sort", |ctx: NativeCallContext, l: &mut List| -> RResult<List> {
        sort_list(&ctx, l, None)?;
        Ok(l.clone())
    });
    engine.register_fn("js_is_array", |d: Dynamic| d.is::<List>());
    // [...a, b, ...c]: `parts` alternates a spread flag and a value.
    engine.register_fn("js_build", |parts: Array| {
        let mut out = Vec::new();
        for pair in parts.chunks(2) {
            let (spread, v) = (pair[0].as_bool().unwrap_or(false), pair.get(1).cloned().unwrap_or(Dynamic::UNIT));
            if !spread {
                out.push(v);
            } else if let Some(l) = v.read_lock::<List>() {
                out.extend(l.0.borrow().iter().cloned());
            } else if let Some(s) = v.read_lock::<JsSet>() {
                out.extend(s.0.borrow().values().cloned());
            } else if let Some(m) = v.read_lock::<JsMap>() {
                out.extend(m.0.borrow().values().map(|(k, v)| Dynamic::from(List::new(vec![k.clone(), v.clone()]))));
            } else if let Some(f) = v.read_lock::<super::rmath::Floats>() {
                out.extend(f.0.borrow().iter().map(|x| Dynamic::from_float(*x as f64)));
            } else if let Some(s) = v.read_lock::<ImmutableString>() {
                out.extend(s.chars().map(|c| Dynamic::from(c.to_string())));
            }
        }
        List::new(out)
    });

    // Callbacks: (item), (item, index), (accumulator, item) ...
    macro_rules! each {
        ($ctx:expr, $l:expr, $f:expr, $n:expr, |$i:ident, $x:ident, $r:ident| $body:block) => {{
            let items = $l.0.borrow().clone();
            for ($i, $x) in items.into_iter().enumerate() {
                let args = if $n == 1 { vec![$x.clone()] } else { vec![$x.clone(), Dynamic::from_float($i as f64)] };
                let $r = call(&$ctx, &$f, args)?;
                $body
            }
        }};
    }
    for n in [1usize, 2] {
        let suffix = n.to_string();
        engine.register_fn(format!("js_map{suffix}"), move |ctx: NativeCallContext, l: &mut List, f: FnPtr| -> RResult<List> {
            let mut out = Vec::new();
            each!(ctx, l, f, n, |_i, x, r| { out.push(r); });
            Ok(List::new(out))
        });
        engine.register_fn(format!("js_filter{suffix}"), move |ctx: NativeCallContext, l: &mut List, f: FnPtr| -> RResult<List> {
            let mut out = Vec::new();
            each!(ctx, l, f, n, |_i, x, r| { if truthy(&r) { out.push(x); } });
            Ok(List::new(out))
        });
        engine.register_fn(format!("js_find{suffix}"), move |ctx: NativeCallContext, l: &mut List, f: FnPtr| -> RResult<Dynamic> {
            each!(ctx, l, f, n, |_i, x, r| { if truthy(&r) { return Ok(x); } });
            Ok(Dynamic::UNIT)
        });
        engine.register_fn(format!("js_findIndex{suffix}"), move |ctx: NativeCallContext, l: &mut List, f: FnPtr| -> RResult<FLOAT> {
            each!(ctx, l, f, n, |i, x, r| { if truthy(&r) { return Ok(i as FLOAT); } });
            Ok(-1.0)
        });
        engine.register_fn(format!("js_some{suffix}"), move |ctx: NativeCallContext, l: &mut List, f: FnPtr| -> RResult<bool> {
            each!(ctx, l, f, n, |_i, x, r| { if truthy(&r) { return Ok(true); } });
            Ok(false)
        });
        engine.register_fn(format!("js_every{suffix}"), move |ctx: NativeCallContext, l: &mut List, f: FnPtr| -> RResult<bool> {
            each!(ctx, l, f, n, |_i, x, r| { if !truthy(&r) { return Ok(false); } });
            Ok(true)
        });
        engine.register_fn(format!("js_forEach{suffix}"), move |ctx: NativeCallContext, l: &mut List, f: FnPtr| -> RResult<()> {
            each!(ctx, l, f, n, |_i, x, _r| {});
            Ok(())
        });
        engine.register_fn(format!("js_flatMap{suffix}"), move |ctx: NativeCallContext, l: &mut List, f: FnPtr| -> RResult<List> {
            let mut out = Vec::new();
            each!(ctx, l, f, n, |_i, x, r| {
                match r.read_lock::<List>() {
                    Some(inner) => out.extend(inner.0.borrow().iter().cloned()),
                    None => out.push(r.clone()),
                }
            });
            Ok(List::new(out))
        });
    }
    engine.register_fn("js_reduce", |ctx: NativeCallContext, l: &mut List, f: FnPtr, init: Dynamic| -> RResult<Dynamic> {
        let mut acc = init;
        for x in l.0.borrow().clone() {
            acc = call(&ctx, &f, vec![acc, x])?;
        }
        Ok(acc)
    });

    // --- Map and Set ---
    engine.register_type_with_name::<JsMap>("Map");
    engine.register_iterator::<JsMap>();
    engine.register_fn("js_new_map", || JsMap::default());
    engine.register_fn("js_new_map", |entries: List| {
        let m = JsMap::default();
        for e in entries.0.borrow().iter() {
            if let Some(pair) = e.read_lock::<List>() {
                let p = pair.0.borrow();
                let (k, v) = (p.first().cloned().unwrap_or(Dynamic::UNIT), p.get(1).cloned().unwrap_or(Dynamic::UNIT));
                m.0.borrow_mut().insert(key_of(&k), (k, v));
            }
        }
        m
    });
    engine.register_fn("get", |m: &mut JsMap, k: Dynamic| m.0.borrow().get(&key_of(&k)).map(|e| e.1.clone()).unwrap_or(Dynamic::UNIT));
    engine.register_fn("set", |m: &mut JsMap, k: Dynamic, v: Dynamic| {
        m.0.borrow_mut().insert(key_of(&k), (k, v));
        m.clone()
    });
    engine.register_fn("has", |m: &mut JsMap, k: Dynamic| m.0.borrow().contains_key(&key_of(&k)));
    engine.register_fn("delete", |m: &mut JsMap, k: Dynamic| m.0.borrow_mut().shift_remove(&key_of(&k)).is_some());
    engine.register_fn("clear", |m: &mut JsMap| m.0.borrow_mut().clear());
    engine.register_get("size", |m: &mut JsMap| m.0.borrow().len() as FLOAT);
    engine.register_fn("keys", |m: &mut JsMap| List::new(m.0.borrow().values().map(|e| e.0.clone()).collect()));
    engine.register_fn("values", |m: &mut JsMap| List::new(m.0.borrow().values().map(|e| e.1.clone()).collect()));
    engine.register_fn("entries", |m: &mut JsMap| List::new(m.0.borrow().values().map(|(k, v)| Dynamic::from(List::new(vec![k.clone(), v.clone()]))).collect()));

    engine.register_type_with_name::<JsSet>("Set");
    engine.register_iterator::<JsSet>();
    engine.register_fn("js_new_set", || JsSet::default());
    engine.register_fn("js_new_set", |items: Dynamic| {
        let s = JsSet::default();
        let list: Vec<Dynamic> = if let Some(l) = items.read_lock::<List>() { l.0.borrow().clone() } else if let Some(o) = items.read_lock::<JsSet>() { o.0.borrow().values().cloned().collect() } else { Vec::new() };
        for x in list {
            s.0.borrow_mut().insert(key_of(&x), x);
        }
        s
    });
    engine.register_fn("add", |s: &mut JsSet, x: Dynamic| {
        s.0.borrow_mut().insert(key_of(&x), x);
        s.clone()
    });
    engine.register_fn("has", |s: &mut JsSet, x: Dynamic| s.0.borrow().contains_key(&key_of(&x)));
    engine.register_fn("delete", |s: &mut JsSet, x: Dynamic| s.0.borrow_mut().shift_remove(&key_of(&x)).is_some());
    engine.register_fn("clear", |s: &mut JsSet| s.0.borrow_mut().clear());
    engine.register_get("size", |s: &mut JsSet| s.0.borrow().len() as FLOAT);
    engine.register_fn("values", |s: &mut JsSet| List::new(s.0.borrow().values().cloned().collect()));

    // --- Operators ---
    engine.register_fn("truthy", |d: Dynamic| truthy(&d));
    engine.register_fn("js_eq", |a: Dynamic, b: Dynamic| js_eq(&a, &b));
    engine.register_fn("js_str", |d: Dynamic| js_str(&d));
    engine.register_fn("js_typeof", |d: Dynamic| js_typeof(&d).to_string());
    engine.register_fn("js_num", |d: Dynamic| num(&d));
    engine.register_fn("js_add", |a: Dynamic, b: Dynamic| -> Dynamic {
        // `+`: concatenation when either side is a string, else numbers.
        if a.is_string() || b.is_string() {
            Dynamic::from(format!("{}{}", js_str(&a), js_str(&b)))
        } else {
            Dynamic::from_float(num(&a) + num(&b))
        }
    });
    engine.register_fn("js_plain", |d: Dynamic| plain(&d));
    engine.register_fn("js_is_nullish", |d: Dynamic| d.is_unit());
    // Bitwise operators work on 32-bit integers in JavaScript.
    let i32_ = |x: FLOAT| -> i32 { if x.is_finite() { (x.trunc() as i64) as i32 } else { 0 } };
    engine.register_fn("js_bor", move |a: FLOAT, b: FLOAT| (i32_(a) | i32_(b)) as FLOAT);
    engine.register_fn("js_band", move |a: FLOAT, b: FLOAT| (i32_(a) & i32_(b)) as FLOAT);
    engine.register_fn("js_bxor", move |a: FLOAT, b: FLOAT| (i32_(a) ^ i32_(b)) as FLOAT);
    engine.register_fn("js_shl", move |a: FLOAT, b: FLOAT| i32_(a).wrapping_shl((i32_(b) & 31) as u32) as FLOAT);
    engine.register_fn("js_shr", move |a: FLOAT, b: FLOAT| (i32_(a) >> (i32_(b) & 31)) as FLOAT);
    engine.register_fn("js_ushr", move |a: FLOAT, b: FLOAT| ((i32_(a) as u32) >> (i32_(b) & 31)) as FLOAT);
    engine.register_fn("js_imul", move |a: FLOAT, b: FLOAT| i32_(a).wrapping_mul(i32_(b)) as FLOAT);

    // --- Math ---
    engine.register_fn("js_round", round_js);
    engine.register_fn("js_trunc", |x: FLOAT| x.trunc());
    engine.register_fn("js_sign", |x: FLOAT| if x > 0.0 { 1.0 } else if x < 0.0 { -1.0 } else { x });
    engine.register_fn("js_max", |a: FLOAT, b: FLOAT| if a.is_nan() || b.is_nan() { f64::NAN } else { a.max(b) });
    engine.register_fn("js_max", |a: FLOAT, b: FLOAT, c: FLOAT| a.max(b).max(c));
    engine.register_fn("js_max", |a: FLOAT, b: FLOAT, c: FLOAT, d: FLOAT| a.max(b).max(c).max(d));
    engine.register_fn("js_min", |a: FLOAT, b: FLOAT| if a.is_nan() || b.is_nan() { f64::NAN } else { a.min(b) });
    engine.register_fn("js_min", |a: FLOAT, b: FLOAT, c: FLOAT| a.min(b).min(c));
    engine.register_fn("js_min", |a: FLOAT, b: FLOAT, c: FLOAT, d: FLOAT| a.min(b).min(c).min(d));
    engine.register_fn("js_max_list", |l: List| l.0.borrow().iter().map(num).fold(f64::NEG_INFINITY, f64::max));
    engine.register_fn("js_min_list", |l: List| l.0.borrow().iter().map(num).fold(f64::INFINITY, f64::min));
    engine.register_fn("js_hypot", |a: FLOAT, b: FLOAT| a.hypot(b));
    engine.register_fn("js_hypot", |a: FLOAT, b: FLOAT, c: FLOAT| (a * a + b * b + c * c).sqrt());
    engine.register_fn("js_hypot_list", |l: List| l.0.borrow().iter().map(|x| num(x) * num(x)).sum::<f64>().sqrt());
    engine.register_fn("js_cbrt", |x: FLOAT| x.cbrt());
    engine.register_fn("js_atan2", |y: FLOAT, x: FLOAT| y.atan2(x));
    engine.register_fn("js_pow", |a: FLOAT, b: FLOAT| a.powf(b));
    engine.register_fn("js_is_finite", |d: Dynamic| (d.is_float() || d.is_int()) && num(&d).is_finite());
    engine.register_fn("js_is_nan", |x: FLOAT| x.is_nan());
    engine.register_fn("js_to_fixed", |x: FLOAT, d: FLOAT| format!("{:.*}", d.clamp(0.0, 20.0) as usize, x));
    engine.register_fn("js_to_precision", |x: FLOAT, p: FLOAT| {
        let p = p.clamp(1.0, 21.0) as i32;
        if x == 0.0 || !x.is_finite() {
            return if x == 0.0 { format!("{:.*}", (p - 1) as usize, 0.0) } else { fmt_num(x) };
        }
        let e = x.abs().log10().floor() as i32;
        if e < -6 || e >= p {
            let s = format!("{:.*e}", (p - 1) as usize, x);
            let (m, ex) = s.split_once('e').unwrap_or((&s, "0"));
            let ex: i32 = ex.parse().unwrap_or(0);
            format!("{m}e{}{}", if ex >= 0 { "+" } else { "-" }, ex.abs())
        } else {
            format!("{:.*}", (p - 1 - e).max(0) as usize, x)
        }
    });
    engine.register_fn("js_locale", |x: FLOAT| {
        let n = round_js(x);
        let digits = format!("{:.0}", n.abs());
        let mut out = String::new();
        for (i, c) in digits.chars().enumerate() {
            if i > 0 && (digits.len() - i) % 3 == 0 {
                out.push(',');
            }
            out.push(c);
        }
        if n < 0.0 { format!("-{out}") } else { out }
    });
    engine.register_fn("js_parse_float", |s: ImmutableString| {
        let t = s.trim();
        let end = t.char_indices().take_while(|(i, c)| c.is_ascii_digit() || *c == '.' || ((*c == '-' || *c == '+') && *i == 0) || *c == 'e' || *c == 'E').map(|(i, c)| i + c.len_utf8()).last().unwrap_or(0);
        t[..end].parse::<f64>().unwrap_or(f64::NAN)
    });

    // --- Strings (UTF-16 indexing is approximated by chars) ---
    engine.register_fn("js_len", |s: ImmutableString| s.chars().count() as FLOAT);
    engine.register_fn("js_slice", |s: ImmutableString, a: FLOAT| {
        let c: Vec<char> = s.chars().collect();
        let (x, y) = bounds(c.len(), Some(a), None);
        c[x..y].iter().collect::<String>()
    });
    engine.register_fn("js_slice", |s: ImmutableString, a: FLOAT, b: FLOAT| {
        let c: Vec<char> = s.chars().collect();
        let (x, y) = bounds(c.len(), Some(a), Some(b));
        c[x..y].iter().collect::<String>()
    });
    engine.register_fn("js_char_at", |s: ImmutableString, i: FLOAT| s.chars().nth(i.max(0.0) as usize).map(|c| c.to_string()).unwrap_or_default());
    engine.register_fn("js_char_code_at", |s: ImmutableString, i: FLOAT| s.encode_utf16().nth(i.max(0.0) as usize).map(|c| c as FLOAT).unwrap_or(f64::NAN));
    engine.register_fn("js_index_of", |s: ImmutableString, sub: ImmutableString| s.find(sub.as_str()).map(|b| s[..b].chars().count() as FLOAT).unwrap_or(-1.0));
    engine.register_fn("js_includes", |s: ImmutableString, sub: ImmutableString| s.contains(sub.as_str()));
    engine.register_fn("js_starts_with", |s: ImmutableString, p: ImmutableString| s.starts_with(p.as_str()));
    engine.register_fn("js_ends_with", |s: ImmutableString, p: ImmutableString| s.ends_with(p.as_str()));
    engine.register_fn("js_upper", |s: ImmutableString| s.to_uppercase());
    engine.register_fn("js_lower", |s: ImmutableString| s.to_lowercase());
    engine.register_fn("js_trim", |s: ImmutableString| s.trim().to_string());
    engine.register_fn("js_split", |s: ImmutableString, sep: ImmutableString| {
        if sep.is_empty() {
            list_of_strings(s.chars().map(|c| c.to_string()).collect())
        } else {
            list_of_strings(s.split(sep.as_str()).map(|x| x.to_string()).collect())
        }
    });
    engine.register_fn("js_repeat", |s: ImmutableString, n: FLOAT| s.repeat(n.max(0.0) as usize));
    engine.register_fn("js_pad_start", |s: ImmutableString, n: FLOAT, p: ImmutableString| {
        let len = s.chars().count();
        let n = n.max(0.0) as usize;
        if len >= n || p.is_empty() {
            return s.to_string();
        }
        let pad: String = p.chars().cycle().take(n - len).collect();
        pad + s.as_str()
    });
    engine.register_fn("js_pad_end", |s: ImmutableString, n: FLOAT, p: ImmutableString| {
        let len = s.chars().count();
        let n = n.max(0.0) as usize;
        if len >= n || p.is_empty() {
            return s.to_string();
        }
        let pad: String = p.chars().cycle().take(n - len).collect();
        format!("{}{pad}", s.as_str())
    });
    engine.register_fn("js_replace_all", |s: ImmutableString, a: ImmutableString, b: ImmutableString| s.replace(a.as_str(), b.as_str()));
    // Regular expressions: only `test`, compiled per pattern and cached.
    engine.register_fn("js_re_test", |pattern: ImmutableString, s: ImmutableString| -> RResult<bool> {
        thread_local! {
            static CACHE: RefCell<std::collections::HashMap<String, regex_lite::Regex>> = RefCell::new(Default::default());
        }
        CACHE.with(|c| {
            let mut c = c.borrow_mut();
            if !c.contains_key(pattern.as_str()) {
                let re = regex_lite::Regex::new(&pattern).map_err(|e| format!("regex {pattern}: {e}"))?;
                c.insert(pattern.to_string(), re);
            }
            Ok(c[pattern.as_str()].is_match(&s))
        })
    });
    // `text.replace(/\{(\w+)\}/g, (_, k) => ...)`: every {name} through the callback.
    engine.register_fn("js_replace_braces", |ctx: NativeCallContext, s: ImmutableString, f: FnPtr| -> RResult<String> {
        let mut out = String::new();
        let mut rest = s.as_str();
        while let Some(open) = rest.find('{') {
            let after = &rest[open + 1..];
            let close = after.find('}');
            match close {
                Some(close) if close > 0 && after[..close].chars().all(|c| c.is_alphanumeric() || c == '_') => {
                    out.push_str(&rest[..open]);
                    let name = &after[..close];
                    let r = call(&ctx, &f, vec![Dynamic::from(format!("{{{name}}}")), Dynamic::from(name.to_string())])?;
                    out.push_str(&js_str(&r));
                    rest = &after[close + 1..];
                }
                _ => {
                    out.push_str(&rest[..open + 1]);
                    rest = after;
                }
            }
        }
        out.push_str(rest);
        Ok(out)
    });

    // --- JSON ---
    engine.register_fn("js_json_parse", |s: ImmutableString| -> RResult<Dynamic> {
        let v: serde_json::Value = serde_json::from_str(&s).map_err(|e| format!("JSON.parse: {e}"))?;
        Ok(from_json_value(&v))
    });
    engine.register_fn("js_json_stringify", |d: Dynamic| to_json(&d).to_string());
}


// --- Intrinsics: the hot helpers of translated games, native -------------------------------------

fn l3(d: &Dynamic) -> [f64; 3] {
    if let Some(l) = d.read_lock::<List>() {
        let v = l.0.borrow();
        return [v.first().map(num).unwrap_or(0.0), v.get(1).map(num).unwrap_or(0.0), v.get(2).map(num).unwrap_or(0.0)];
    }
    if let Some(a) = d.read_lock::<Array>() {
        return [a.first().map(num).unwrap_or(0.0), a.get(1).map(num).unwrap_or(0.0), a.get(2).map(num).unwrap_or(0.0)];
    }
    [0.0; 3]
}
fn lv(l: &List) -> [f64; 3] {
    let v = l.0.borrow();
    [v.first().map(num).unwrap_or(0.0), v.get(1).map(num).unwrap_or(0.0), v.get(2).map(num).unwrap_or(0.0)]
}
fn v3l(v: [f64; 3]) -> List {
    List::new(vec![Dynamic::from_float(v[0]), Dynamic::from_float(v[1]), Dynamic::from_float(v[2])])
}
fn opt(d: &Dynamic, default: f64) -> f64 {
    if d.is_unit() { default } else { num(d) }
}
fn floats_of(d: &Dynamic, out: &mut [f32]) {
    if let Some(l) = d.read_lock::<List>() {
        for (o, v) in out.iter_mut().zip(l.0.borrow().iter()) {
            *o = num(v) as f32;
        }
    }
}

fn add_record(b: &super::rmath::Batches, key: &str, m: &List, v0: &Dynamic, v1: &Dynamic, v2: &Dynamic) {
    let mut inner = b.0.borrow_mut();
    let rec = inner.add(key, None);
    {
        let mv = m.0.borrow();
        for (o, v) in rec.iter_mut().zip(mv.iter()).take(16) {
            *o = num(v) as f32;
        }
    }
    if rec.len() >= 20 { floats_of(v0, &mut rec[16..20]); }
    if rec.len() >= 24 { floats_of(v1, &mut rec[20..24]); }
    if rec.len() >= 28 { floats_of(v2, &mut rec[24..28]); }
}

/// Accessors on `Obj` for these property names (`o.name` then skips Rhai's indexer fallback).
pub fn register_props(engine: &mut Engine, names: impl Iterator<Item = ImmutableString>) {
    for name in names {
        if matches!(name.as_str(), "length" | "size" | "lastStats") {
            continue;
        }
        let (k, k2) = (name.clone(), name.clone());
        engine.register_get(name.as_str(), move |o: &mut Obj| o.0.borrow().get(&k).cloned().unwrap_or(Dynamic::UNIT));
        engine.register_set(name.as_str(), move |o: &mut Obj, v: Dynamic| {
            o.0.borrow_mut().insert(k2.clone(), v);
        });
    }
}

/// The native side of TypeScript helpers a translation config marks as provided: `nk_math`'s
/// vectors and `Rng`, `placed`/`oriented` matrices, and instance records from a matrix list.
pub fn register_intrinsics(engine: &mut Engine) {
    use super::rmath::{basis_of, hash_string, oriented, placed, Batches, Rng};
    engine.register_fn("add", |a: List, b: List| { let (a, b) = (lv(&a), lv(&b)); v3l([a[0] + b[0], a[1] + b[1], a[2] + b[2]]) });
    engine.register_fn("sub", |a: List, b: List| { let (a, b) = (lv(&a), lv(&b)); v3l([a[0] - b[0], a[1] - b[1], a[2] - b[2]]) });
    engine.register_fn("mul", |a: List, s: FLOAT| { let a = lv(&a); v3l([a[0] * s, a[1] * s, a[2] * s]) });
    engine.register_fn("dot", |a: List, b: List| { let (a, b) = (lv(&a), lv(&b)); a[0] * b[0] + a[1] * b[1] + a[2] * b[2] });
    engine.register_fn("cross", |a: List, b: List| { let (a, b) = (lv(&a), lv(&b)); v3l([a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]) });
    engine.register_fn("len", |a: List| { let a = lv(&a); a[0].hypot(a[1]).hypot(a[2]) });
    engine.register_fn("dist", |a: List, b: List| { let (a, b) = (lv(&a), lv(&b)); (a[0] - b[0]).hypot(a[1] - b[1]).hypot(a[2] - b[2]) });
    engine.register_fn("norm", |a: List, fb: Dynamic| {
        let a = lv(&a);
        let l = a[0].hypot(a[1]).hypot(a[2]);
        if l > 1e-12 { v3l([a[0] / l, a[1] / l, a[2] / l]) } else if fb.is_unit() { v3l([0.0, 0.0, 1.0]) } else { v3l(l3(&fb)) }
    });
    engine.register_fn("lerp3", |a: List, b: List, t: FLOAT| { let (a, b) = (lv(&a), lv(&b)); v3l([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]) });
    engine.register_fn("clamp", |v: FLOAT, lo: Dynamic, hi: Dynamic| { let (lo, hi) = (opt(&lo, 0.0), opt(&hi, 1.0)); if v < lo { lo } else if v > hi { hi } else { v } });
    engine.register_fn("forwardOf", |yaw: FLOAT, pitch: FLOAT| v3l([yaw.sin() * pitch.cos(), pitch.sin(), yaw.cos() * pitch.cos()]));
    engine.register_fn("basis", |f: List| {
        let (r, u) = basis_of(lv(&f));
        let o = Obj::default();
        o.set("right", Dynamic::from(v3l(r)));
        o.set("up", Dynamic::from(v3l(u)));
        o
    });
    engine.register_fn("segmentDistance", |p: List, a: List, b: List| {
        let (p, a, b) = (lv(&p), lv(&a), lv(&b));
        let ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        let l2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
        let t = if l2 > 0.0 { (((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1] + (p[2] - a[2]) * ab[2]) / l2).clamp(0.0, 1.0) } else { 0.0 };
        (p[0] - a[0] - ab[0] * t).hypot(p[1] - a[1] - ab[1] * t).hypot(p[2] - a[2] - ab[2] * t)
    });
    engine.register_fn("hashString", |s: ImmutableString| hash_string(&s) as FLOAT);
    engine.register_fn("smooth", |a: FLOAT, b: FLOAT, v: FLOAT| { let t = ((v - a) / (b - a)).clamp(0.0, 1.0); t * t * (3.0 - 2.0 * t) });

    // `new Rng(seed)` and its methods, under the translator's class naming.
    engine.register_fn("Rng__new", |seed: Dynamic| {
        if let Some(s) = seed.read_lock::<ImmutableString>() {
            return Rng::new(hash_string(&s));
        }
        // `seed >>> 0 || 1` as the TypeScript constructor does.
        let n = num(&seed);
        Rng::new(if n.is_finite() { (n.trunc() as i64) as u32 } else { 0 })
    });
    engine.register_fn("Rng__next", |r: &mut Rng| r.next());
    engine.register_fn("Rng__range", |r: &mut Rng, a: FLOAT, b: FLOAT| r.range(a, b));
    engine.register_fn("Rng__int", |r: &mut Rng, a: FLOAT, b: FLOAT| r.range(a, b + 1.0).floor());
    engine.register_fn("Rng__pick", |r: &mut Rng, items: List| -> Dynamic {
        let v = items.0.borrow();
        if v.is_empty() {
            return Dynamic::UNIT;
        }
        let i = ((r.next() * v.len() as f64).floor() as usize).min(v.len() - 1);
        v[i].clone()
    });
    engine.register_fn("Rng__dir", |r: &mut Rng| v3l(r.dir()));
    engine.register_fn("Rng__ball", |r: &mut Rng| {
        let d = r.dir();
        let k = r.next().cbrt();
        v3l([d[0] * k, d[1] * k, d[2] * k])
    });

    let m16 = |m: [f32; 16]| List::new(m.iter().map(|x| Dynamic::from_float(*x as f64)).collect());
    engine.register_fn("placed", move |p: List, sx: FLOAT, sy: Dynamic, sz: Dynamic| m16(placed(lv(&p), [sx, opt(&sy, sx), opt(&sz, sx)])));
    engine.register_fn("oriented", move |p: List, f: List, sx: FLOAT, sy: FLOAT, sz: FLOAT, up: Dynamic| {
        let up = if up.is_unit() { [0.0, 1.0, 0.0] } else { l3(&up) };
        m16(oriented(lv(&p), lv(&f), [sx, sy, sz], up))
    });
    // A record: a 16-float matrix list, then up to three vec4 lists.
    engine.register_fn("add_mat", |b: &mut Batches, key: ImmutableString, m: List, v0: Dynamic, v1: Dynamic, v2: Dynamic| add_record(b, &key, &m, &v0, &v1, &v2));
    // The scene's Draw interface, natively: `d` is a Renderer object holding `solids` and `glows`.
    engine.register_fn("draw_solid", |d: Obj, mesh: ImmutableString, m: List, color: Dynamic, params: Dynamic, extra: Dynamic| -> RResult<()> {
        let b = d.get("solids").try_cast::<Batches>().ok_or("draw_solid: the renderer has no solids batches")?;
        add_record(&b, &mesh, &m, &color, &params, &extra);
        Ok(())
    });
    engine.register_fn("draw_glow", |d: Obj, m: List, color: Dynamic, kind: FLOAT, seed: Dynamic, place: Dynamic, extra: Dynamic| -> RResult<()> {
        let b = d.get("glows").try_cast::<Batches>().ok_or("draw_glow: the renderer has no glows batches")?;
        let mut inner = b.0.borrow_mut();
        let rec = inner.add("quad", None);
        {
            let mv = m.0.borrow();
            for (o, v) in rec.iter_mut().zip(mv.iter()).take(16) {
                *o = num(v) as f32;
            }
        }
        floats_of(&color, &mut rec[16..20]);
        rec[20..24].copy_from_slice(&[kind as f32, opt(&seed, 0.0) as f32, 0.0, opt(&place, 0.0) as f32]);
        floats_of(&extra, &mut rec[24..28]);
        Ok(())
    });
    engine.register_get("lastStats", |b: &mut Batches| {
        let o = Obj::default();
        for (k, v) in b.0.borrow().last.iter() {
            o.set(k.as_str(), Dynamic::from_float(num(v)));
        }
        o
    });

    // --- More JavaScript ---
    engine.register_fn("js_nan", || f64::NAN);
    // Rhai's float comparisons answer false against a true infinity (`1.0 < inf`, `inf == inf`), which
    // broke every "best so far" search seeded with `Infinity` (siphon found no target). The largest
    // finite float orders correctly and `fmt_num` still prints it as Infinity.
    engine.register_fn("js_inf", || f64::MAX);
    engine.register_fn("js_date_now", || web_time::SystemTime::now().duration_since(web_time::UNIX_EPOCH).map(|d| d.as_secs_f64() * 1000.0).unwrap_or(0.0).floor());
    engine.register_fn("js_push_all", |l: List, items: List| {
        let more = items.0.borrow().clone();
        let mut v = l.0.borrow_mut();
        v.extend(more);
        v.len() as FLOAT
    });
    engine.register_fn("js_list_entries", |l: List| List::new(l.0.borrow().iter().enumerate().map(|(i, x)| Dynamic::from(List::new(vec![Dynamic::from_float(i as f64), x.clone()]))).collect()));
    engine.register_fn("js_list_keys", |l: List| List::new((0..l.0.borrow().len()).map(|i| Dynamic::from_float(i as f64)).collect()));
    engine.register_fn("js_at", |l: List, i: FLOAT| {
        let v = l.0.borrow();
        let i = if i < 0.0 { v.len() as f64 + i } else { i };
        if i < 0.0 { Dynamic::UNIT } else { v.get(i as usize).cloned().unwrap_or(Dynamic::UNIT) }
    });
    engine.register_fn("js_new_array", |n: FLOAT| List::new(vec![Dynamic::UNIT; n.max(0.0) as usize]));
    engine.register_fn("js_is_integer", |d: Dynamic| { let n = num(&d); (d.is_float() || d.is_int()) && n.is_finite() && n.fract() == 0.0 });
    engine.register_fn("js_replace_first", |s: ImmutableString, a: ImmutableString, b: ImmutableString| s.replacen(a.as_str(), b.as_str(), 1));
    engine.register_fn("js_coll_for_each", |ctx: NativeCallContext, c: Dynamic, f: FnPtr| -> RResult<()> {
        // Map: (value, key); Set: (value, value).
        let items: Vec<(Dynamic, Dynamic)> = if let Some(m) = c.read_lock::<JsMap>() {
            m.0.borrow().values().map(|(k, v)| (v.clone(), k.clone())).collect()
        } else if let Some(s) = c.read_lock::<JsSet>() {
            s.0.borrow().values().map(|v| (v.clone(), v.clone())).collect()
        } else {
            Vec::new()
        };
        for (a, b) in items {
            call(&ctx, &f, vec![a, b])?;
        }
        Ok(())
    });
    // A caught error as JavaScript sees one: an object with a message.
    engine.register_fn("js_error", |e: Dynamic| -> Dynamic {
        if e.is::<Obj>() {
            return e;
        }
        let msg = if let Some(m) = e.read_lock::<Map>() { m.get("message").map(js_str).unwrap_or_else(|| e.to_string()) } else { js_str(&e) };
        let o = Obj::default();
        o.set("message", Dynamic::from(msg));
        Dynamic::from(o)
    });
    // `x.m(args)` where `m` is an interface method: a closure held in a property, or a method of
    // the object's class (`__class`, set by every translated constructor).
    engine.register_fn("js_icall", |ctx: NativeCallContext, o: Dynamic, name: ImmutableString, args: Array| -> RResult<Dynamic> {
        let (field, class) = match o.read_lock::<Obj>() {
            Some(ob) => (ob.get(&name), ob.get("__class")),
            None => return Err(format!("{name}() called on {}", js_typeof(&o)).into()),
        };
        if let Some(f) = field.read_lock::<FnPtr>() {
            return call(&ctx, &f, args);
        }
        let class = class.into_immutable_string().map_err(|_| format!("{name} is not a function"))?;
        let mut this = o.clone();
        let mut args = args;
        let mut refs: Vec<&mut Dynamic> = std::iter::once(&mut this).chain(args.iter_mut()).collect();
        ctx.call_fn_raw(format!("{class}__{name}"), true, true, &mut refs)
    });

    // Typed arrays (Float32Array) are Floats.
    use super::rmath::Floats;
    engine.register_fn("floats_f", |n: FLOAT| Floats::new(n.max(0.0) as usize));
    engine.register_fn("js_floats_from", |d: Dynamic| {
        let v: Vec<f32> = if let Some(l) = d.read_lock::<List>() { l.0.borrow().iter().map(|x| num(x) as f32).collect() } else { Vec::new() };
        Floats(Rc::new(RefCell::new(v)))
    });
    engine.register_get("length", |f: &mut Floats| f.0.borrow().len() as FLOAT);
    engine.register_indexer_get(|f: &mut Floats, i: FLOAT| f.0.borrow().get(i as usize).map(|x| *x as FLOAT).unwrap_or(f64::NAN));
    engine.register_indexer_set(|f: &mut Floats, i: FLOAT, v: FLOAT| {
        if let Some(x) = f.0.borrow_mut().get_mut(i as usize) {
            *x = v as f32;
        }
    });
    engine.register_fn("js_floats_set", |f: Floats, src: Dynamic, offset: FLOAT| {
        let vals: Vec<f32> = if let Some(l) = src.read_lock::<List>() { l.0.borrow().iter().map(|x| num(x) as f32).collect() } else if let Some(s) = src.read_lock::<Floats>() { s.0.borrow().clone() } else { Vec::new() };
        let mut v = f.0.borrow_mut();
        let o = offset.max(0.0) as usize;
        for (i, x) in vals.into_iter().enumerate() {
            if let Some(slot) = v.get_mut(o + i) {
                *slot = x;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn eng() -> Engine {
        let mut e = Engine::new();
        register(&mut e);
        e
    }

    #[test]
    fn objects_and_lists_are_shared_like_javascript() {
        let e = eng();
        let r: String = e
            .eval(
                r#"
                let p = obj(#{ x: 1.0, pos: list([0.0, 0.0, 0.0]) });
                let q = p; q.x = 2.0;
                let l = list([p]); l[0].x += 1.0;
                fn bump(o) { o.x += 10.0; }
                bump(p);
                let pos = p.pos; pos[1] = 5.0;
                let s = js_new_set(); s.add("a"); s.add("a");
                let m = js_new_map(); m.set(p, "me");
                `${js_str(p.x)} ${js_str(p.pos[1])} ${js_str(s.size)} ${m.get(q)} ${l.js_map1(|o| o.x).join("|")}`
                "#,
            )
            .unwrap();
        assert_eq!(r, "13 5 1 me 13");
    }

    #[test]
    fn javascript_formatting_and_truthiness() {
        assert_eq!(fmt_num(3.0), "3");
        assert_eq!(fmt_num(0.1 + 0.2), "0.30000000000000004");
        assert_eq!(fmt_num(-0.0), "0");
        assert!(!truthy(&Dynamic::from_float(0.0)));
        assert!(!truthy(&Dynamic::from("")));
        assert!(truthy(&Dynamic::from(List::default())));
        let e = eng();
        let s: String = e.eval(r#"js_replace_braces("Press {fire} or {x}", |m, k| if k == "fire" { "[LMB]" } else { m })"#).unwrap();
        assert_eq!(s, "Press [LMB] or {x}");
        let j: String = e.eval(r#"js_json_stringify(js_json_parse("{\"a\":[1,2.5,{\"b\":null}],\"c\":\"d\"}"))"#).unwrap();
        // Rhai has one "nothing" for null and undefined; stringify leaves it out, as JS does undefined.
        assert_eq!(j, r#"{"a":[1,2.5,{}],"c":"d"}"#);
    }
}
