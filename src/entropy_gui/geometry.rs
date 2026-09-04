//! Basic 2D geometry types. Mirrors egui's shapes closely so call sites port unchanged.

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Vec2 {
    pub x: f32,
    pub y: f32,
}

impl Vec2 {
    pub const ZERO: Vec2 = Vec2 { x: 0.0, y: 0.0 };

    pub fn new(x: f32, y: f32) -> Self {
        Self { x, y }
    }

    pub fn splat(v: f32) -> Self {
        Self { x: v, y: v }
    }

    pub fn length(&self) -> f32 {
        (self.x * self.x + self.y * self.y).sqrt()
    }

    pub fn max(self, other: Vec2) -> Vec2 {
        Vec2::new(self.x.max(other.x), self.y.max(other.y))
    }
}

pub fn vec2(x: f32, y: f32) -> Vec2 {
    Vec2::new(x, y)
}

impl std::ops::Add for Vec2 {
    type Output = Vec2;
    fn add(self, rhs: Vec2) -> Vec2 {
        Vec2::new(self.x + rhs.x, self.y + rhs.y)
    }
}
impl std::ops::Sub for Vec2 {
    type Output = Vec2;
    fn sub(self, rhs: Vec2) -> Vec2 {
        Vec2::new(self.x - rhs.x, self.y - rhs.y)
    }
}
impl std::ops::Mul<f32> for Vec2 {
    type Output = Vec2;
    fn mul(self, rhs: f32) -> Vec2 {
        Vec2::new(self.x * rhs, self.y * rhs)
    }
}
impl std::ops::AddAssign for Vec2 {
    fn add_assign(&mut self, rhs: Vec2) {
        self.x += rhs.x;
        self.y += rhs.y;
    }
}
impl std::ops::Neg for Vec2 {
    type Output = Vec2;
    fn neg(self) -> Vec2 {
        Vec2::new(-self.x, -self.y)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Pos2 {
    pub x: f32,
    pub y: f32,
}

impl Pos2 {
    pub fn new(x: f32, y: f32) -> Self {
        Self { x, y }
    }

    pub fn to_vec2(&self) -> Vec2 {
        Vec2::new(self.x, self.y)
    }
}

pub fn pos2(x: f32, y: f32) -> Pos2 {
    Pos2::new(x, y)
}

impl std::ops::Add<Vec2> for Pos2 {
    type Output = Pos2;
    fn add(self, rhs: Vec2) -> Pos2 {
        Pos2::new(self.x + rhs.x, self.y + rhs.y)
    }
}
impl std::ops::Sub for Pos2 {
    type Output = Vec2;
    fn sub(self, rhs: Pos2) -> Vec2 {
        Vec2::new(self.x - rhs.x, self.y - rhs.y)
    }
}
impl std::ops::Sub<Vec2> for Pos2 {
    type Output = Pos2;
    fn sub(self, rhs: Vec2) -> Pos2 {
        Pos2::new(self.x - rhs.x, self.y - rhs.y)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Rect {
    pub min: Pos2,
    pub max: Pos2,
}

impl Rect {
    pub const NOTHING: Rect = Rect {
        min: Pos2 { x: f32::INFINITY, y: f32::INFINITY },
        max: Pos2 { x: f32::NEG_INFINITY, y: f32::NEG_INFINITY },
    };

    pub fn from_min_size(min: Pos2, size: Vec2) -> Self {
        Self { min, max: Pos2::new(min.x + size.x, min.y + size.y) }
    }

    pub fn from_min_max(min: Pos2, max: Pos2) -> Self {
        Self { min, max }
    }

    pub fn from_center_size(center: Pos2, size: Vec2) -> Self {
        Self::from_min_size(pos2(center.x - size.x / 2.0, center.y - size.y / 2.0), size)
    }

    pub fn everything() -> Self {
        Self {
            min: pos2(f32::NEG_INFINITY, f32::NEG_INFINITY),
            max: pos2(f32::INFINITY, f32::INFINITY),
        }
    }

    pub fn width(&self) -> f32 {
        self.max.x - self.min.x
    }
    pub fn height(&self) -> f32 {
        self.max.y - self.min.y
    }
    pub fn size(&self) -> Vec2 {
        vec2(self.width(), self.height())
    }
    pub fn center(&self) -> Pos2 {
        pos2((self.min.x + self.max.x) * 0.5, (self.min.y + self.max.y) * 0.5)
    }
    pub fn left_top(&self) -> Pos2 {
        self.min
    }
    pub fn right_top(&self) -> Pos2 {
        pos2(self.max.x, self.min.y)
    }
    pub fn left_bottom(&self) -> Pos2 {
        pos2(self.min.x, self.max.y)
    }
    pub fn right_bottom(&self) -> Pos2 {
        self.max
    }
    pub fn left_center(&self) -> Pos2 {
        pos2(self.min.x, self.center().y)
    }
    pub fn contains(&self, p: Pos2) -> bool {
        p.x >= self.min.x && p.x <= self.max.x && p.y >= self.min.y && p.y <= self.max.y
    }
    pub fn expand(&self, amount: f32) -> Rect {
        Rect::from_min_max(pos2(self.min.x - amount, self.min.y - amount), pos2(self.max.x + amount, self.max.y + amount))
    }
    pub fn shrink(&self, amount: f32) -> Rect {
        self.expand(-amount)
    }
    pub fn shrink2(&self, amount: Vec2) -> Rect {
        Rect::from_min_max(pos2(self.min.x + amount.x, self.min.y + amount.y), pos2(self.max.x - amount.x, self.max.y - amount.y))
    }
    pub fn translate(&self, delta: Vec2) -> Rect {
        Rect::from_min_max(self.min + delta, self.max + delta)
    }
    pub fn intersect(&self, other: Rect) -> Rect {
        Rect::from_min_max(
            pos2(self.min.x.max(other.min.x), self.min.y.max(other.min.y)),
            pos2(self.max.x.min(other.max.x), self.max.y.min(other.max.y)),
        )
    }
    pub fn is_positive(&self) -> bool {
        self.width() > 0.0 && self.height() > 0.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Align {
    Min,
    Center,
    Max,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Align2(pub Align, pub Align);

impl Align2 {
    pub const LEFT_TOP: Align2 = Align2(Align::Min, Align::Min);
    pub const LEFT_CENTER: Align2 = Align2(Align::Min, Align::Center);
    pub const CENTER_CENTER: Align2 = Align2(Align::Center, Align::Center);
    pub const CENTER: Align2 = Align2::CENTER_CENTER;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    LeftToRight,
    RightToLeft,
    TopDown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Layout {
    pub main_dir: Direction,
    pub main_align: Align,
    pub cross_align: Align,
}

impl Layout {
    pub fn left_to_right(cross_align: Align) -> Self {
        Self { main_dir: Direction::LeftToRight, main_align: Align::Min, cross_align }
    }
    pub fn top_down(cross_align: Align) -> Self {
        Self { main_dir: Direction::TopDown, main_align: Align::Min, cross_align }
    }
    pub fn right_to_left(cross_align: Align) -> Self {
        Self { main_dir: Direction::RightToLeft, main_align: Align::Min, cross_align }
    }
}

/// A single u8-radius corner rounding (all four corners equal) — the only variant this app uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct CornerRadius(pub u8);

impl CornerRadius {
    pub fn same(v: u8) -> Self {
        Self(v)
    }
    pub fn as_f32(&self) -> f32 {
        self.0 as f32
    }
}
impl From<u8> for CornerRadius {
    fn from(v: u8) -> Self {
        Self(v)
    }
}
impl From<f32> for CornerRadius {
    fn from(v: f32) -> Self {
        Self(v.round().clamp(0.0, 255.0) as u8)
    }
}
impl From<i32> for CornerRadius {
    fn from(v: i32) -> Self {
        Self(v.clamp(0, 255) as u8)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Margin {
    pub left: i8,
    pub right: i8,
    pub top: i8,
    pub bottom: i8,
}

impl Margin {
    pub fn same(v: i8) -> Self {
        Self { left: v, right: v, top: v, bottom: v }
    }
    pub fn symmetric(x: i8, y: i8) -> Self {
        Self { left: x, right: x, top: y, bottom: y }
    }
    pub fn sum(&self) -> Vec2 {
        vec2((self.left + self.right) as f32, (self.top + self.bottom) as f32)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FontFamily {
    Proportional,
    Monospace,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FontId {
    pub size: f32,
    pub family: FontFamily,
}

impl FontId {
    pub fn proportional(size: f32) -> Self {
        Self { size, family: FontFamily::Proportional }
    }
    pub fn monospace(size: f32) -> Self {
        Self { size, family: FontFamily::Monospace }
    }
}

impl Default for FontId {
    fn default() -> Self {
        Self::proportional(14.0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StrokeKind {
    Inside,
    Middle,
    Outside,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CursorIcon {
    Default,
    PointingHand,
    Text,
    ResizeHorizontal,
    ResizeVertical,
    ResizeNwSe,
    ResizeNeSw,
    Grab,
    Grabbing,
    NotAllowed,
}

impl Default for CursorIcon {
    fn default() -> Self {
        CursorIcon::Default
    }
}
