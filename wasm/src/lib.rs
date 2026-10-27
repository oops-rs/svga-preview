//! Browser adapter. Rendering policy stays here, outside the codec's API.
use serde_json::{Value, json};
use svga::movie::{Geometry, LineCap, LineJoin, Rgba, Shape, Transform};
use svga::{Animation, Limits};
use wasm_bindgen::prelude::*;

const MIB: usize = 1024 * 1024;

#[wasm_bindgen]
pub struct Preview {
    animation: Animation,
}

#[wasm_bindgen]
impl Preview {
    #[wasm_bindgen(constructor)]
    pub fn new(bytes: &[u8]) -> Result<Preview, JsValue> {
        let animation = decode(bytes).map_err(|message| JsValue::from_str(&message))?;
        Ok(Self { animation })
    }

    /// Images travel separately as typed arrays, never base64 or JSON numbers.
    pub fn image(&self, key: &str) -> Vec<u8> {
        self.animation.image(key).unwrap_or_default().to_vec()
    }

    pub fn metadata(&self) -> String {
        model(&self.animation).to_string()
    }
}

fn decode(bytes: &[u8]) -> Result<Animation, String> {
    let limits = Limits::default()
        .with_max_input_bytes(32 * MIB)
        .with_max_inflated_bytes(96 * MIB)
        .with_max_spec_bytes(4 * MIB)
        .with_max_elements(250_000)
        .with_max_fields(100_000);
    let animation = Animation::from_bytes_with(bytes, &limits).map_err(|e| e.to_string())?;
    let p = animation.movie().params;
    if !p.view_box_width.is_finite()
        || !p.view_box_height.is_finite()
        || !(1.0..=4096.0).contains(&p.view_box_width)
        || !(1.0..=4096.0).contains(&p.view_box_height)
        || !(1..=240).contains(&p.fps)
        || !(1..=36_000).contains(&p.frames)
    {
        return Err("Invalid or oversized movie: expected a 1–4096 px canvas, 1–240 fps and 1–36000 frames.".into());
    }
    let movie = animation.movie();
    if movie.sprites.len() > 4096 || movie.images.len() > 4096 {
        return Err("This movie exceeds the preview limit of 4096 layers or assets.".into());
    }
    // Zip aliases may reference the same large asset many times. Bound the
    // expanded JS transfer, not only the original archive's inflated bytes.
    let mut image_bytes = 0usize;
    for image in &movie.images {
        image_bytes = image_bytes
            .checked_add(animation.image(&image.key).map_or(0, <[u8]>::len))
            .filter(|total| *total <= 96 * MIB)
            .ok_or("Resolved image assets exceed the 96 MB preview limit.")?;
    }
    let mut path_bytes = 0usize;
    let mut count_path = |path: &str| -> Result<(), String> {
        path_bytes += path.len();
        if path.len() > 100_000 || path_bytes > 2 * MIB {
            return Err("Vector paths exceed the browser preview complexity limit.".into());
        }
        Ok(())
    };
    for sprite in &movie.sprites {
        for frame in &sprite.frames {
            count_path(&frame.clip_path)?;
            for shape in &frame.shapes {
                if let Geometry::Path { d } = &shape.geometry {
                    count_path(d)?;
                }
            }
        }
    }
    Ok(animation)
}

fn matrix(t: Transform) -> [f32; 6] {
    [t.a, t.b, t.c, t.d, t.tx, t.ty]
}

fn color(c: Option<Rgba>) -> Option<[f32; 4]> {
    c.map(|c| [c.r, c.g, c.b, c.a])
}

fn shape(s: &Shape) -> Value {
    let geometry = match &s.geometry {
        Geometry::Path { d } => json!({"type": "path", "d": d}),
        Geometry::Rect {
            x,
            y,
            width,
            height,
            corner_radius,
        } => {
            json!({"type": "rect", "x": x, "y": y, "width": width, "height": height, "radius": corner_radius})
        }
        Geometry::Ellipse {
            x,
            y,
            radius_x,
            radius_y,
        } => {
            json!({"type": "ellipse", "x": x, "y": y, "rx": radius_x, "ry": radius_y})
        }
        Geometry::Keep => json!({"type": "keep"}),
    };
    let style = s.styles.map(|s| json!({
        "fill": color(s.fill), "stroke": color(s.stroke), "width": s.stroke_width,
        "cap": match s.line_cap { LineCap::Butt => "butt", LineCap::Round => "round", LineCap::Square => "square" },
        "join": match s.line_join { LineJoin::Miter => "miter", LineJoin::Round => "round", LineJoin::Bevel => "bevel" },
        "miter": s.miter_limit, "dash": s.line_dash,
    }));
    json!({"geometry": geometry, "matrix": matrix(s.transform.unwrap_or(Transform::IDENTITY)), "style": style})
}

fn model(animation: &Animation) -> Value {
    let m = animation.movie();
    let images: Vec<_> = m
        .images
        .iter()
        .map(|image| {
            let bytes = animation.image(&image.key).unwrap_or_default();
            json!({"key": image.key, "bytes": bytes.len(),
            "kind": format!("{:?}", svga::ValueKind::sniff(bytes)),
            "animated": svga::is_animated_png(bytes),
            "dimensions": svga::png_dimensions(bytes)})
        })
        .collect();
    let sprites: Vec<_> = m
        .sprites
        .iter()
        .map(|sprite| {
            let frames: Vec<_> = sprite
                .frames
                .iter()
                .map(|f| {
                    json!({
                        "alpha": f.alpha, "matrix": matrix(f.matrix()), "clip": f.clip_path,
                        "shapes": f.shapes.iter().map(shape).collect::<Vec<_>>()
                    })
                })
                .collect();
            json!({"key": sprite.image_key, "image": sprite.image_name(),
            "matte": sprite.matte_key, "isMatte": sprite.is_matte(), "frames": frames})
        })
        .collect();
    json!({"version": m.version, "format": format!("{:?}", animation.format()),
        "width": m.params.view_box_width, "height": m.params.view_box_height,
        "fps": m.params.fps, "frames": m.params.frames, "images": images,
        "sprites": sprites, "audioCount": m.audios.len()})
}

#[cfg(test)]
mod tests {
    use super::*;
    use svga::movie::{Frame, Movie, Params, Sprite};

    fn fixture(params: Params) -> Vec<u8> {
        let movie = Movie {
            params,
            sprites: vec![Sprite {
                frames: vec![Frame {
                    alpha: 1.0,
                    ..Default::default()
                }],
                ..Default::default()
            }],
            ..Default::default()
        };
        svga::Document::from_movie(&movie, &[])
            .unwrap()
            .to_bytes(svga::Compression::Fast)
            .unwrap()
    }

    #[test]
    fn real_codec_roundtrip_preserves_implicit_identity() {
        let animation = decode(&fixture(Params {
            view_box_width: 100.0,
            view_box_height: 100.0,
            fps: 30,
            frames: 1,
        }))
        .unwrap();
        assert_eq!(
            model(&animation)["sprites"][0]["frames"][0]["matrix"],
            json!([1.0, 0.0, 0.0, 1.0, 0.0, 0.0])
        );
    }

    #[test]
    fn rejects_invalid_movie_and_malformed_input() {
        for width in [0.0, f32::NAN, 4097.0] {
            assert!(
                decode(&fixture(Params {
                    view_box_width: width,
                    view_box_height: 100.0,
                    fps: 30,
                    frames: 1
                }))
                .is_err()
            );
        }
        assert!(decode(b"not an SVGA").is_err());
    }
}
