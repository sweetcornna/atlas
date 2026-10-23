// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Images the shell draws itself rather than ships.

use tauri::image::Image;

/// The Windows taskbar's stand-in for a badge count: a 16 px dot in the
/// front's unread colour (`--color-interactive`), edges smoothed.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn badge_dot() -> Image<'static> {
    const SIZE: u32 = 16;
    let (r, g, b) = (0x2a, 0x78, 0xd6);
    let mut rgba = Vec::with_capacity((SIZE * SIZE * 4) as usize);
    let centre = (SIZE as f32 - 1.0) / 2.0;
    let radius = SIZE as f32 / 2.0 - 1.0;
    for y in 0..SIZE {
        for x in 0..SIZE {
            let d = ((x as f32 - centre).powi(2) + (y as f32 - centre).powi(2)).sqrt();
            let alpha = (radius + 0.5 - d).clamp(0.0, 1.0);
            rgba.extend_from_slice(&[r, g, b, (alpha * 255.0) as u8]);
        }
    }
    Image::new_owned(rgba, SIZE, SIZE)
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_dot_is_round_and_opaque_in_the_middle() {
        let dot = super::badge_dot();
        assert_eq!((dot.width(), dot.height()), (16, 16));
        let alpha = |x: usize, y: usize| dot.rgba()[(y * 16 + x) * 4 + 3];
        assert_eq!(alpha(8, 8), 255);
        assert_eq!(alpha(0, 0), 0);
        assert_eq!(alpha(15, 15), 0);
    }
}
