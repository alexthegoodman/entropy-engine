//! # entropy-cad
//!
//! The geometry kernel under Entropy's CAD apps (Design first; Engineering, Architecture and
//! Electronics to follow). It is plain Rust with no engine dependencies, so it also runs headless:
//! in tests, in tools, on the web.
//!
//! * [`nurbs`] - exact curves: lines, arcs, ellipses, splines through points, weighted control splines.
//! * [`sketch`] - curves on a plane sharing points; finds closed regions (with holes), open paths,
//!   strokes (asymmetric outlines around a curve), snapping and curvature combs.
//! * [`features`] - the document: a history of sketches and the features that turn them into bodies
//!   (extrude, revolve, loft, sweep), reshape them (twist, bend, taper, shear, mirror) and combine
//!   them (add, cut, intersect), evaluated incrementally.
//! * [`mesh`] - what bodies evaluate to: triangles with smooth normals, named faces, sharp edges;
//!   triangulation, ray casting, measurement.
//! * [`boolean`] - joining, cutting and intersecting bodies.
//! * [`export`] - STL and OBJ.
//!
//! ```
//! use entropy_cad::features::{Document, Evaluator, Options};
//! let doc: Document = serde_json::from_str(r#"{"features":[
//!   {"id":"s","type":"sketch","plane":{"base":"top"},"points":[{"id":"c","x":0,"y":0}],
//!    "entities":[{"id":"ring","type":"circle","center":"c","radius":10}]},
//!   {"id":"vase","type":"extrude","profile":{"sketch":"s"},
//!    "forward":{"distance":60,"scale":[0.6,0.9],"twist":40,"bulge":0.35}}]}"#).unwrap();
//! let result = Evaluator::default().evaluate(&doc, &Options::default());
//! assert!(result.issues.is_empty());
//! assert_eq!(result.bodies[0].mesh.open_edges(), 0);
//! ```

pub mod boolean;
pub mod export;
pub mod features;
pub mod math;
pub mod mesh;
pub mod nurbs;
pub mod sketch;
