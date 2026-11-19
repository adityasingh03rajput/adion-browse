/**
 * Adion Browse — PC screen capture
 *
 * Adapted from nus-companion's companion/src/screen.js (Apache-2.0,
 * potlakai/nus-companion v0.1.21). One display, downscaled to 1280 px on the
 * long side: plenty for "which control", a fraction of the tokens of a 4K
 * frame. Physical pixels and the scale factor travel with the image so boxes
 * can be mapped back exactly.
 */

'use strict';

const MAX_SIDE = 1280;

/**
 * captureDisplay(displayId) -> null | {
 *   dataUrl, width, height, pxWidth, pxHeight,
 *   display: { id, bounds, workArea, scaleFactor }
 * }
 */
async function captureDisplay(displayId) {
  const electron = require('electron');
  const { desktopCapturer, screen } = electron;
  if (!desktopCapturer || !screen) return null;

  const displays = screen.getAllDisplays();
  const display = (displayId != null && displays.find((d) => d.id === displayId)) || screen.getPrimaryDisplay();
  if (!display) return null;

  const scale = display.scaleFactor || 1;
  const pxWidth = Math.floor(display.size.width * scale);
  const pxHeight = Math.floor(display.size.height * scale);

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: pxWidth, height: pxHeight }
  });
  if (!sources || !sources.length) return null;

  const source = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
  let image = source.thumbnail;
  if (!image || image.isEmpty()) return null;

  const size = image.getSize();
  const longest = Math.max(size.width, size.height);
  if (longest > MAX_SIDE) {
    const factor = MAX_SIDE / longest;
    image = image.resize({
      width: Math.round(size.width * factor),
      height: Math.round(size.height * factor),
      quality: 'good'
    });
  }
  const output = image.getSize();
  return {
    dataUrl: image.toDataURL(),
    width: output.width,
    height: output.height,
    pxWidth: size.width,
    pxHeight: size.height,
    display: {
      id: display.id,
      bounds: display.bounds,
      workArea: display.workArea,
      scaleFactor: scale
    }
  };
}

module.exports = { captureDisplay, MAX_SIDE };
