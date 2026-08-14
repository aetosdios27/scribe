//! Animated wordmark widget for the bare `scribe` splash screen.
//!
//! The frozen ANSI-Shadow geometry in `assets/scribe-logo.txt` is parsed once,
//! then rendered with:
//!
//! - a deep-cobalt → bright-cobalt base gradient,
//! - an icy-white moving cloud,
//! - several softly composited cloud lobes,
//! - a faint static diagonal sheen,
//! - subtly reactive shadow illumination.
//!
//! Animation phase is expressed as an integer in `[0, 1000]`.
//! All shader math uses fixed-point integer arithmetic so rendering remains
//! deterministic, dependency-free, and cheap.

use std::sync::OnceLock;

use ratatui::{
    buffer::Buffer,
    layout::Rect,
    style::{Color, Style},
    widgets::Widget,
};

pub const SCRIBE_LOGO: &str = include_str!("../assets/scribe-logo.txt");

type Rgb = (u8, u8, u8);

// -----------------------------------------------------------------------------
// Fixed-point domain
// -----------------------------------------------------------------------------

const SCALE: u32 = 1000;
const SCALE_U16: u16 = 1000;
const SCALE_I32: i32 = 1000;
const SCALE_I64: i64 = 1000;

// -----------------------------------------------------------------------------
// Palette
// -----------------------------------------------------------------------------

const COBALT_DEEP: Rgb = (43, 82, 201);
const COBALT_BRIGHT: Rgb = (80, 131, 230);
const ICY_WHITE: Rgb = (238, 244, 255);

const SHADOW_DEEP: Rgb = (16, 31, 92);
const SHADOW_BRIGHT: Rgb = (24, 48, 120);
const SHADOW_LIT: Rgb = (52, 91, 176);

// -----------------------------------------------------------------------------
// Base face gradient
// -----------------------------------------------------------------------------

const GRADIENT_X_WEIGHT: u32 = 74;
const GRADIENT_Y_WEIGHT: u32 = 26;
const GRADIENT_WEIGHT_TOTAL: u32 = GRADIENT_X_WEIGHT + GRADIENT_Y_WEIGHT;

// -----------------------------------------------------------------------------
// Moving cloud
// -----------------------------------------------------------------------------

const CLOUD_PATH_START_X: i32 = -650;
const CLOUD_PATH_START_Y: i32 = 180;

const CLOUD_PATH_DELTA_X: i32 = 2300;
const CLOUD_PATH_DELTA_Y: i32 = 640;

#[derive(Clone, Copy)]
struct CloudLayer {
    offset_x: i32,
    offset_y: i32,
    radius: i32,
    weight: u32,
}

const CLOUD_LAYERS: [CloudLayer; 4] = [
    // Large, low-opacity halo around the whole effect.
    CloudLayer {
        offset_x: -40,
        offset_y: 50,
        radius: 650,
        weight: 230,
    },
    // Main white cloud.
    CloudLayer {
        offset_x: 0,
        offset_y: 0,
        radius: 455,
        weight: SCALE,
    },
    // Softer trailing lobe.
    CloudLayer {
        offset_x: -270,
        offset_y: 170,
        radius: 355,
        weight: 600,
    },
    // Small leading wisp.
    CloudLayer {
        offset_x: 215,
        offset_y: -135,
        radius: 285,
        weight: 390,
    },
];

const ELLIPSE_Y_SQUISH_NUM: i64 = 3;
const ELLIPSE_Y_SQUISH_DEN: i64 = 2;

// -----------------------------------------------------------------------------
// Ambient sheen
// -----------------------------------------------------------------------------

const AMBIENT_X_WEIGHT: u32 = 78;
const AMBIENT_Y_WEIGHT: u32 = 22;
const AMBIENT_WEIGHT_TOTAL: u32 = AMBIENT_X_WEIGHT + AMBIENT_Y_WEIGHT;

const AMBIENT_BAND_CENTER: u32 = 560;
const AMBIENT_BAND_HALF_WIDTH: u32 = 300;
const AMBIENT_PEAK_STRENGTH: u32 = 145;

// -----------------------------------------------------------------------------
// Shadow response
// -----------------------------------------------------------------------------

const SHADOW_CLOUD_RESPONSE: u32 = 230;
const SHADOW_AMBIENT_RESPONSE: u32 = 90;

// -----------------------------------------------------------------------------
// Frozen logo geometry
// -----------------------------------------------------------------------------

#[derive(Clone, Copy)]
struct LogoCell {
    x: u16,
    y: u16,
    ch: char,
    face: bool,
}

struct LogoGeometry {
    width: u16,
    height: u16,
    cells: Vec<LogoCell>,
}

static LOGO_GEOMETRY: OnceLock<LogoGeometry> = OnceLock::new();

fn geometry() -> &'static LogoGeometry {
    LOGO_GEOMETRY.get_or_init(build_geometry)
}

fn build_geometry() -> LogoGeometry {
    let mut width = 0usize;
    let mut height = 0usize;
    let mut cells = Vec::new();

    for (row, line) in SCRIBE_LOGO.lines().enumerate() {
        height = height.max(row.saturating_add(1));

        let line_width = line.chars().count();
        width = width.max(line_width);

        let Ok(y) = u16::try_from(row) else {
            continue;
        };

        for (column, ch) in line.chars().enumerate() {
            if ch == ' ' {
                continue;
            }

            let Ok(x) = u16::try_from(column) else {
                continue;
            };

            cells.push(LogoCell {
                x,
                y,
                ch,
                face: is_face_character(ch),
            });
        }
    }

    LogoGeometry {
        width: u16::try_from(width).unwrap_or(u16::MAX),
        height: u16::try_from(height).unwrap_or(u16::MAX),
        cells,
    }
}

// -----------------------------------------------------------------------------
// Widget
// -----------------------------------------------------------------------------

pub struct ScribeLogo {
    phase: u16,
}

impl ScribeLogo {
    pub fn new(phase: u16) -> Self {
        Self {
            phase: phase.min(SCALE_U16),
        }
    }
}

impl Widget for ScribeLogo {
    fn render(self, area: Rect, buf: &mut Buffer) {
        if area.width == 0 || area.height == 0 {
            return;
        }

        let geometry = geometry();
        let color_enabled = logo_color_enabled();

        let width = u32::from(geometry.width);
        let height = u32::from(geometry.height);

        for cell in &geometry.cells {
            if cell.x >= area.width || cell.y >= area.height {
                continue;
            }

            let x = area.x.saturating_add(cell.x);
            let y = area.y.saturating_add(cell.y);

            let style = if color_enabled {
                let color = if cell.face {
                    face_color(
                        u32::from(cell.x),
                        u32::from(cell.y),
                        width,
                        height,
                        self.phase,
                    )
                } else {
                    shadow_color(
                        u32::from(cell.x),
                        u32::from(cell.y),
                        width,
                        height,
                        self.phase,
                    )
                };

                Style::default().fg(color)
            } else {
                Style::default()
            };

            buf[(x, y)].set_char(cell.ch).set_style(style);
        }
    }
}

fn logo_color_enabled() -> bool {
    if std::env::var_os("NO_COLOR").is_some() {
        return false;
    }

    if std::env::var("FORCE_COLOR").is_ok_and(|value| value == "0") {
        return false;
    }

    !std::env::var("TERM").is_ok_and(|term| term == "dumb")
}

// -----------------------------------------------------------------------------
// Geometry classification
// -----------------------------------------------------------------------------

fn is_face_character(ch: char) -> bool {
    matches!(
        ch,
        '█' | '▀' | '▄' | '▌' | '▐' | '▉' | '▊' | '▋' | '▍' | '▎' | '▏'
    )
}

// -----------------------------------------------------------------------------
// Face shader
// -----------------------------------------------------------------------------

fn face_color(x: u32, y: u32, width: u32, height: u32, phase: u16) -> Color {
    let x = normalized_position(x, width);
    let y = normalized_position(y, height);

    let base_position = weighted_position(
        x,
        y,
        GRADIENT_X_WEIGHT,
        GRADIENT_Y_WEIGHT,
        GRADIENT_WEIGHT_TOTAL,
    );

    let base = lerp_rgb(COBALT_DEEP, COBALT_BRIGHT, base_position, SCALE);

    let highlight = highlight_strength(x, y, phase);

    let (red, green, blue) = lerp_rgb(base, ICY_WHITE, highlight, SCALE);

    Color::Rgb(red, green, blue)
}

// -----------------------------------------------------------------------------
// Shadow shader
// -----------------------------------------------------------------------------

fn shadow_color(x: u32, y: u32, width: u32, height: u32, phase: u16) -> Color {
    let x = normalized_position(x, width);
    let y = normalized_position(y, height);

    let base_position = weighted_position(
        x,
        y,
        GRADIENT_X_WEIGHT,
        GRADIENT_Y_WEIGHT,
        GRADIENT_WEIGHT_TOTAL,
    );

    let base = lerp_rgb(SHADOW_DEEP, SHADOW_BRIGHT, base_position, SCALE);

    let moving = scale_strength(cloud_strength(x, y, phase), SHADOW_CLOUD_RESPONSE);

    let ambient = scale_strength(ambient_highlight(x, y), SHADOW_AMBIENT_RESPONSE);

    let illumination = composite_strength(moving, ambient);

    let (red, green, blue) = lerp_rgb(base, SHADOW_LIT, illumination, SCALE);

    Color::Rgb(red, green, blue)
}

// -----------------------------------------------------------------------------
// Lighting
// -----------------------------------------------------------------------------

fn highlight_strength(x: u32, y: u32, phase: u16) -> u32 {
    composite_strength(cloud_strength(x, y, phase), ambient_highlight(x, y))
}

fn cloud_strength(x: u32, y: u32, phase: u16) -> u32 {
    let phase = i32::from(phase.min(SCALE_U16));

    let center_x = CLOUD_PATH_START_X + ((phase * CLOUD_PATH_DELTA_X) / SCALE_I32);

    let center_y = CLOUD_PATH_START_Y + ((phase * CLOUD_PATH_DELTA_Y) / SCALE_I32);

    CLOUD_LAYERS.iter().fold(0, |combined, layer| {
        let raw = radial_cloud(
            x,
            y,
            center_x + layer.offset_x,
            center_y + layer.offset_y,
            layer.radius,
        );

        let weighted = scale_strength(raw, layer.weight);

        composite_strength(combined, weighted)
    })
}

fn radial_cloud(x: u32, y: u32, center_x: i32, center_y: i32, radius: i32) -> u32 {
    if radius <= 0 {
        return 0;
    }

    let x = i64::from(x);
    let y = i64::from(y);

    let center_x = i64::from(center_x);
    let center_y = i64::from(center_y);
    let radius = i64::from(radius);

    let dx = x - center_x;

    let dy = (y - center_y).saturating_mul(ELLIPSE_Y_SQUISH_NUM) / ELLIPSE_Y_SQUISH_DEN;

    let distance_squared = dx.saturating_mul(dx).saturating_add(dy.saturating_mul(dy));

    let radius_squared = radius.saturating_mul(radius);

    if distance_squared >= radius_squared {
        return 0;
    }

    let remaining = radius_squared - distance_squared;

    let linear = remaining
        .saturating_mul(SCALE_I64)
        .checked_div(radius_squared)
        .unwrap_or(0);

    let linear = u32::try_from(linear).unwrap_or(SCALE).min(SCALE);

    smoothstep(linear)
}

fn ambient_highlight(x: u32, y: u32) -> u32 {
    let diagonal = weighted_position(
        x,
        y,
        AMBIENT_X_WEIGHT,
        AMBIENT_Y_WEIGHT,
        AMBIENT_WEIGHT_TOTAL,
    );

    let distance = diagonal.abs_diff(AMBIENT_BAND_CENTER);

    if distance >= AMBIENT_BAND_HALF_WIDTH {
        return 0;
    }

    let remaining = AMBIENT_BAND_HALF_WIDTH - distance;

    let normalized = remaining
        .saturating_mul(SCALE)
        .checked_div(AMBIENT_BAND_HALF_WIDTH)
        .unwrap_or(0);

    scale_strength(smoothstep(normalized), AMBIENT_PEAK_STRENGTH)
}

// -----------------------------------------------------------------------------
// Fixed-point helpers
// -----------------------------------------------------------------------------

fn weighted_position(x: u32, y: u32, x_weight: u32, y_weight: u32, total_weight: u32) -> u32 {
    if total_weight == 0 {
        return 0;
    }

    x.saturating_mul(x_weight)
        .saturating_add(y.saturating_mul(y_weight))
        .checked_div(total_weight)
        .unwrap_or(0)
        .min(SCALE)
}

fn normalized_position(position: u32, length: u32) -> u32 {
    if length <= 1 {
        return 0;
    }

    position
        .saturating_mul(SCALE)
        .checked_div(length - 1)
        .unwrap_or(0)
        .min(SCALE)
}

/// Smoothstep over `[0, SCALE]`.
///
/// Equivalent to `3t² - 2t³`, but entirely in fixed-point integer space.
fn smoothstep(value: u32) -> u32 {
    let value = u64::from(value.min(SCALE));
    let scale = u64::from(SCALE);

    let numerator = value.saturating_mul(value).saturating_mul(
        scale
            .saturating_mul(3)
            .saturating_sub(value.saturating_mul(2)),
    );

    let denominator = scale.saturating_mul(scale);

    u32::try_from(numerator.checked_div(denominator).unwrap_or(0))
        .unwrap_or(SCALE)
        .min(SCALE)
}

/// Combines two light strengths without the ugly hard clipping produced by
/// `a + b`. This behaves like screen/alpha-union compositing:
///
/// `1 - (1 - a)(1 - b)`.
fn composite_strength(a: u32, b: u32) -> u32 {
    let a = a.min(SCALE);
    let b = b.min(SCALE);

    let darkness = SCALE
        .saturating_sub(a)
        .saturating_mul(SCALE.saturating_sub(b))
        / SCALE;

    SCALE.saturating_sub(darkness)
}

fn scale_strength(value: u32, weight: u32) -> u32 {
    value.min(SCALE).saturating_mul(weight.min(SCALE)) / SCALE
}

// -----------------------------------------------------------------------------
// RGB interpolation
// -----------------------------------------------------------------------------

fn lerp_rgb(from: Rgb, to: Rgb, amount: u32, range: u32) -> Rgb {
    (
        lerp_channel(from.0, to.0, amount, range),
        lerp_channel(from.1, to.1, amount, range),
        lerp_channel(from.2, to.2, amount, range),
    )
}

fn lerp_channel(from: u8, to: u8, amount: u32, range: u32) -> u8 {
    if range == 0 {
        return to;
    }

    let from = i64::from(from);
    let to = i64::from(to);

    let amount = i64::from(amount.min(range));
    let range = i64::from(range);

    let value = from + ((to - from) * amount / range);

    u8::try_from(value.clamp(0, 255)).unwrap_or_default()
}

// -----------------------------------------------------------------------------
// Public geometry
// -----------------------------------------------------------------------------

pub fn logo_width() -> u16 {
    geometry().width
}

pub fn logo_height() -> u16 {
    geometry().height
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logo_has_valid_geometry() {
        let geometry = geometry();

        assert!(geometry.width > 0);
        assert!(geometry.height > 0);
        assert!(!geometry.cells.is_empty());

        assert!(geometry.cells.iter().any(|cell| cell.face));

        assert!(geometry.cells.iter().any(|cell| !cell.face));

        assert!(geometry.cells.iter().all(|cell| cell.ch != ' '));
    }

    #[test]
    fn public_dimensions_match_cached_geometry() {
        assert_eq!(logo_width(), geometry().width);
        assert_eq!(logo_height(), geometry().height);
    }

    #[test]
    fn phase_is_clamped() {
        assert_eq!(ScribeLogo::new(0).phase, 0);
        assert_eq!(ScribeLogo::new(500).phase, 500);
        assert_eq!(ScribeLogo::new(u16::MAX).phase, SCALE_U16);
    }

    #[test]
    fn cloud_enters_passes_and_leaves() {
        let before = cloud_strength(500, 500, 0);
        let passing = cloud_strength(500, 500, 500);
        let after = cloud_strength(500, 500, SCALE_U16);

        assert!(passing > before);
        assert!(passing > after);
        assert!(passing > 900);
    }

    #[test]
    fn cloud_strength_is_always_bounded() {
        for phase in [0, 100, 250, 500, 750, 900, SCALE_U16] {
            for x in [0, 250, 500, 750, SCALE] {
                for y in [0, 250, 500, 750, SCALE] {
                    assert!(cloud_strength(x, y, phase) <= SCALE);
                }
            }
        }
    }

    #[test]
    fn composite_strength_has_expected_endpoints() {
        assert_eq!(composite_strength(0, 0), 0);
        assert_eq!(composite_strength(SCALE, 0), SCALE);
        assert_eq!(composite_strength(0, SCALE), SCALE);
        assert_eq!(composite_strength(SCALE, SCALE), SCALE);
    }

    #[test]
    fn composite_strength_does_not_hard_add() {
        let combined = composite_strength(500, 500);

        assert_eq!(combined, 750);
        assert!(combined < SCALE);
    }

    #[test]
    fn smoothstep_has_expected_endpoints() {
        assert_eq!(smoothstep(0), 0);
        assert_eq!(smoothstep(SCALE), SCALE);
        assert_eq!(smoothstep(SCALE / 2), SCALE / 2);
    }

    #[test]
    fn rgb_interpolation_hits_endpoints() {
        assert_eq!(lerp_rgb(COBALT_DEEP, COBALT_BRIGHT, 0, SCALE,), COBALT_DEEP);

        assert_eq!(
            lerp_rgb(COBALT_DEEP, COBALT_BRIGHT, SCALE, SCALE,),
            COBALT_BRIGHT
        );
    }
}
