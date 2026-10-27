//! Original, redistributable fixture; no third-party artwork.
use std::f32::consts::TAU;
use svga::movie::{Frame, Geometry, Movie, Params, Rgba, Shape, ShapeStyle, Sprite, Transform};
use svga::{Compression, Document};

fn color(r: u8, g: u8, b: u8) -> Rgba {
    Rgba {
        r: r as f32 / 255.0,
        g: g as f32 / 255.0,
        b: b as f32 / 255.0,
        a: 1.0,
    }
}

fn path(d: &str, fill: Rgba) -> Shape {
    Shape {
        geometry: Geometry::Path { d: d.into() },
        styles: Some(ShapeStyle {
            fill: Some(fill),
            ..Default::default()
        }),
        ..Default::default()
    }
}

fn sprite(shapes: Vec<Shape>, transform: impl Fn(f32) -> Transform, alpha: f32) -> Sprite {
    Sprite {
        frames: (0..120)
            .map(|i| Frame {
                alpha,
                transform: Some(transform(i as f32 / 120.0 * TAU)),
                shapes: if i == 0 {
                    shapes.clone()
                } else {
                    vec![Shape {
                        geometry: Geometry::Keep,
                        ..Default::default()
                    }]
                },
                ..Default::default()
            })
            .collect(),
        ..Default::default()
    }
}

fn translated(x: f32, y: f32) -> Transform {
    Transform {
        tx: x,
        ty: y,
        ..Transform::IDENTITY
    }
}

fn main() {
    let destination = std::env::args().nth(1).expect("output file path");
    let mut sprites = Vec::new();
    let dark = color(49, 65, 41);
    let green = color(179, 222, 87);
    for angle in [-0.55_f32, 0.55] {
        let ellipse = Shape {
            geometry: Geometry::Ellipse {
                x: 0.0,
                y: 0.0,
                radius_x: 190.0,
                radius_y: 84.0,
            },
            styles: Some(ShapeStyle {
                stroke: Some(dark),
                stroke_width: 1.25,
                ..Default::default()
            }),
            ..Default::default()
        };
        sprites.push(sprite(
            vec![ellipse],
            move |_| Transform {
                a: angle.cos(),
                b: angle.sin(),
                c: -angle.sin(),
                d: angle.cos(),
                tx: 240.0,
                ty: 240.0,
            },
            0.35,
        ));
    }
    let star = "M 0 -146 C 18 -50 50 -18 146 0 C 50 18 18 50 0 146 C -18 50 -50 18 -146 0 C -50 -18 -18 -50 0 -146 Z";
    sprites.push(sprite(
        vec![path(star, dark)],
        |t| {
            let a = 0.16 + t.sin() * 0.12;
            Transform {
                a: a.cos(),
                b: a.sin(),
                c: -a.sin(),
                d: a.cos(),
                tx: 246.0,
                ty: 252.0 + t.sin() * 10.0,
            }
        },
        0.13,
    ));
    sprites.push(sprite(
        vec![path(star, green)],
        |t| {
            let a = 0.16 + t.sin() * 0.12;
            Transform {
                a: a.cos(),
                b: a.sin(),
                c: -a.sin(),
                d: a.cos(),
                tx: 240.0,
                ty: 236.0 + t.sin() * 10.0,
            }
        },
        1.0,
    ));
    sprites.push(sprite(vec![path("M 0 -123 C 16 -43 43 -16 123 0 C 43 16 16 43 0 123 C -16 43 -43 16 -123 0 C -43 -16 -16 -43 0 -123 Z", color(214, 242, 149))], |t| {
        let a = 0.16 + t.sin() * 0.12;
        Transform { a: a.cos(), b: a.sin(), c: -a.sin(), d: a.cos(), tx: 237.0, ty: 232.0 + t.sin() * 10.0 }
    }, 1.0));
    let dot = Shape {
        geometry: Geometry::Ellipse {
            x: 0.0,
            y: 0.0,
            radius_x: 9.0,
            radius_y: 9.0,
        },
        styles: Some(ShapeStyle {
            fill: Some(dark),
            ..Default::default()
        }),
        ..Default::default()
    };
    sprites.push(sprite(
        vec![dot],
        |t| {
            let x = 190.0 * t.cos();
            let y = 84.0 * t.sin();
            let a = -0.55_f32;
            translated(
                240.0 + x * a.cos() - y * a.sin(),
                240.0 + x * a.sin() + y * a.cos(),
            )
        },
        1.0,
    ));
    sprites.push(sprite(
        vec![path(
            "M 0 -12 L 3 -3 L 12 0 L 3 3 L 0 12 L -3 3 L -12 0 L -3 -3 Z",
            dark,
        )],
        |t| translated(92.0, 94.0 + t.sin() * 5.0),
        0.8,
    ));
    let movie = Movie {
        version: "2.0.0".into(),
        params: Params {
            view_box_width: 480.0,
            view_box_height: 480.0,
            fps: 30,
            frames: 120,
        },
        sprites,
        ..Default::default()
    };
    let bytes = Document::from_movie(&movie, &[])
        .unwrap()
        .to_bytes(Compression::Best)
        .unwrap();
    std::fs::write(destination, bytes).unwrap();
}
