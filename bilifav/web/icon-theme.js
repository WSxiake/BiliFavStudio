/* Shared in-memory theme recoloring for navigation and icon previews. */
(() => {
  'use strict';
    function hexToHsl(hex) {
      hex = String(hex).replace('#', '');
      if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
      var r = parseInt(hex.slice(0, 2), 16) / 255;
      var g = parseInt(hex.slice(2, 4), 16) / 255;
      var b = parseInt(hex.slice(4, 6), 16) / 255;
      var mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      var l = (mx + mn) / 2, h = 0, s = 0;
      if (mx !== mn) {
        var d = mx - mn;
        s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
        if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0));
        else if (mx === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h *= 60;
      }
      return { h: h, s: s, l: l };
    }

    function hslToHex(h, s, l) {
      h = ((h % 360) + 360) % 360;
      s = Math.min(1, Math.max(0, s));
      l = Math.min(1, Math.max(0, l));
      var c = (1 - Math.abs(2 * l - 1)) * s;
      var x = c * (1 - Math.abs(((h / 60) % 2) - 1));
      var m = l - c / 2, r = 0, g = 0, b = 0;
      if (h < 60) { r = c; g = x; }
      else if (h < 120) { r = x; g = c; }
      else if (h < 180) { g = c; b = x; }
      else if (h < 240) { g = x; b = c; }
      else if (h < 300) { r = x; b = c; }
      else { r = c; b = x; }
      function to(v) {
        var n = Math.round((v + m) * 255).toString(16);
        return n.length === 1 ? '0' + n : n;
      }
      return '#' + to(r) + to(g) + to(b);
    }

    function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  window.BiliIconTheme = { create: function (images) {
      var entries = [], color = '#566CAE', frame = 0;
      function smooth(a, b, v) {
        var t = clamp((v - a) / (b - a), 0, 1);
        return t * t * (3 - 2 * t);
      }
      function inPolygon(x, y, points) {
        var inside = false;
        for (var i = 0, j = points.length - 1; i < points.length; j = i++) {
          var a = points[i], b = points[j];
          if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
        }
        return inside;
      }
      function rgbHsl(r, g, b) {
        r /= 255; g /= 255; b /= 255;
        var hi = Math.max(r, g, b), lo = Math.min(r, g, b), d = hi - lo;
        var l = (hi + lo) / 2, h = 0;
        if (d) {
          h = hi === r ? ((g - b) / d + (g < b ? 6 : 0)) : hi === g ? (b - r) / d + 2 : (r - g) / d + 4;
          h *= 60;
        }
        return { h: h, s: d ? d / (1 - Math.abs(2 * l - 1)) : 0, l: l };
      }
      function paint(entry) {
        if (entry.color !== color) {
          var theme = hexToHsl(color), palette = [];
          for (var j = 0; j < 256; j++) {
            // Derive the fill from the actual main color, retaining the source shading.
            var light = clamp(theme.l * 0.65 + 0.28 + (j / 255 - 0.80) * 0.72, 0.34, 0.92);
            var hex = hslToHex(theme.h, Math.min(0.82, theme.s * 0.95), light);
            palette.push([parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]);
          }
          entry.output.data.set(entry.source);
          for (var k = 0; k < entry.mask.length; k += 3) {
            var i = entry.mask[k], weight = entry.mask[k + 1], rgb = palette[entry.mask[k + 2]];
            for (var c = 0; c < 3; c++) entry.output.data[i + c] = entry.source[i + c] * (1 - weight) + rgb[c] * weight;
          }
          entry.ctx.putImageData(entry.output, 0, 0);
          entry.color = color;
        }
        entry.canvas.hidden = false;
        entry.img.classList.add('nav-badge-tinted', 'theme-icon-ready');
      }
      async function prepare(img) {
        try {
          img.dataset.tintState = 'loading';
          await img.decode();
          var family = img.dataset.tintFamily || img.closest('.navitem').dataset.page;
          var canvas = document.createElement('canvas');
          // 256px covers the 66px icon at high DPI without processing full-size artwork.
          canvas.width = canvas.height = 256;
          canvas.hidden = true;
          canvas.className = img.classList.contains('nav-badge') ? 'nav-badge-tint ' + (img.classList.contains('nav-badge-active') ? 'nav-tint-active' : 'nav-tint-idle') : 'theme-icon-canvas';
          canvas.setAttribute('aria-hidden', 'true');
          var ctx = canvas.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(img, 0, 0, 256, 256);
          var output = ctx.getImageData(0, 0, 256, 256);
          var source = new Uint8ClampedArray(output.data), mask = [];
          var active = img.classList.contains('nav-badge-active');
          var card = active ? [[0.347,0.248],[0.805,0.36],[0.785,0.625],[0.306,0.505]]
            : [[0.303,0.305],[0.825,0.378],[0.803,0.604],[0.695,0.635],[0.254,0.555]];
          for (var i = 0; i < source.length; i += 4) {
            if (source[i + 3] < 8) continue;
            var hsl = rgbHsl(source[i], source[i + 1], source[i + 2]);
            var x = (i / 4 % 256) / 256, y = Math.floor(i / 4 / 256) / 256;
            var isBlue = family === 'menu' || family === 'organize';
            var distance = isBlue ? Math.abs(hsl.h - 202)
              : family === 'copy' ? Math.abs(hsl.h - 48) : Math.min(hsl.h, 360 - hsl.h);
            var weight = (1 - smooth(isBlue ? 17 : 11, isBlue ? 32 : 24, distance))
              * smooth(0.34, 0.53, hsl.l) * (1 - smooth(0.91, 0.94, hsl.l)) * smooth(0.09, 0.23, hsl.s);
            if (family === 'copy') {
              // Only the yellow video card changes. Box, arrow and gold fittings stay fixed.
              weight *= inPolygon(x, y, card) ? 1 - smooth(0.86, 0.90, hsl.l) : 0;
            }
            if (family === 'menu') {
              // The small whale seal keeps its original blue in both journal poses.
              var cx = active ? 0.475 : 0.615, cy = active ? 0.72 : 0.705;
              if (Math.pow((x - cx) / 0.14, 2) + Math.pow((y - cy) / 0.115, 2) < 1) weight = 0;
            }
            if (weight > 0.001) mask.push(i, weight, Math.round(hsl.l * 255));
          }
          if (!mask.length) { img.dataset.tintState = 'empty'; return; }
          var entry = { img: img, canvas: canvas, ctx: ctx, source: source, output: output,
            mask: new Float32Array(mask), color: null };
          img.after(canvas);
          entries.push(entry);
          paint(entry);
          img.dataset.tintState = 'ready';
        } catch (err) {
          img.dataset.tintState = err.name || 'unavailable';
          // A missing image or unsupported canvas leaves the original usable.
        }
      }
      Array.from(images).forEach(prepare);
      return {
        set: function (main) {
          color = main;
          if (!frame) frame = requestAnimationFrame(function () {
            frame = 0;
            entries.forEach(paint);
          });
        }
      };
  } };
})();
