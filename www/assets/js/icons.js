/* ==========================================================================
   CraveCorner — Icon library (Stage 1 foundation)
   One consistent Lucide-style line-icon family: 24x24 viewBox, 2px stroke,
   round caps/joins, stroke="currentColor". Pink for active states,
   charcoal/neutral for inactive — set via CSS `color`. NEVER emoji as icons.

   Usage:
     document.querySelector('#slot').innerHTML = CC.icon('heart', 'my-class');
     // or inline in a template string: `${CC.icon('search')}`

   Icons are decorative by default (aria-hidden="true"). If an icon is the
   ONLY content of a button/link, put an aria-label on the button/link.
   ========================================================================== */
(function () {
  "use strict";

  window.CC = window.CC || {};

  /* Hand-authored Lucide-style geometry. Each entry is an array of inner
     SVG element strings (paths, circles, rects, lines, polylines, polygons). */
  var ICONS = {
    home: [
      '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
      '<polyline points="9 22 9 12 15 12 15 22"/>'
    ],
    search: [
      '<circle cx="11" cy="11" r="8"/>',
      '<path d="m21 21-4.3-4.3"/>'
    ],
    compass: [
      '<circle cx="12" cy="12" r="10"/>',
      '<polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/>'
    ],
    location: [
      '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/>',
      '<circle cx="12" cy="10" r="3"/>'
    ],
    heart: [
      '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>'
    ],
    message: [
      '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>'
    ],
    bell: [
      '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/>',
      '<path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>'
    ],
    calendar: [
      '<path d="M8 2v4"/>',
      '<path d="M16 2v4"/>',
      '<rect width="18" height="18" x="3" y="4" rx="2"/>',
      '<path d="M3 10h18"/>'
    ],
    plus: [
      '<path d="M5 12h14"/>',
      '<path d="M12 5v14"/>'
    ],
    user: [
      '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/>',
      '<circle cx="12" cy="7" r="4"/>'
    ],
    store: [
      '<path d="m2 7 4.41-4.41A2 2 0 0 1 7.83 2h8.34a2 2 0 0 1 1.42.59L22 7"/>',
      '<path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/>',
      '<path d="M15 22v-4a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v4"/>',
      '<path d="M2 7h20"/>',
      '<path d="M22 7v3a2 2 0 0 1-2 2 2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 16 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 12 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 8 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 4 12a2 2 0 0 1-2-2V7"/>'
    ],
    "shopping-bag": [
      '<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/>',
      '<path d="M3 6h18"/>',
      '<path d="M16 10a4 4 0 0 1-8 0"/>'
    ],
    clipboard: [
      '<rect width="8" height="4" x="8" y="2" rx="1" ry="1"/>',
      '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
      '<path d="M12 11h4"/>',
      '<path d="M12 16h4"/>',
      '<path d="M8 11h.01"/>',
      '<path d="M8 16h.01"/>'
    ],
    settings: [
      '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>',
      '<circle cx="12" cy="12" r="3"/>'
    ],
    shield: [
      '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>'
    ],
    star: [
      '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>'
    ],
    filter: [
      '<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>'
    ],
    edit: [
      '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/>',
      '<path d="m15 5 4 4"/>'
    ],
    delete: [
      '<path d="M3 6h18"/>',
      '<path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/>',
      '<path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
      '<line x1="10" x2="10" y1="11" y2="17"/>',
      '<line x1="14" x2="14" y1="11" y2="17"/>'
    ],
    share: [
      '<circle cx="18" cy="5" r="3"/>',
      '<circle cx="6" cy="12" r="3"/>',
      '<circle cx="18" cy="19" r="3"/>',
      '<line x1="8.59" x2="15.42" y1="13.51" y2="17.49"/>',
      '<line x1="15.41" x2="8.59" y1="6.51" y2="10.49"/>'
    ],
    upload: [
      '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>',
      '<polyline points="17 8 12 3 7 8"/>',
      '<line x1="12" x2="12" y1="3" y2="15"/>'
    ],
    clock: [
      '<circle cx="12" cy="12" r="10"/>',
      '<polyline points="12 6 12 12 16 14"/>'
    ],
    check: [
      '<polyline points="20 6 9 17 4 12"/>'
    ],
    warning: [
      '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/>',
      '<path d="M12 9v4"/>',
      '<path d="M12 17h.01"/>'
    ],
    /* Stage 3 addition: week-navigation chevrons (Lucide-style geometry) */
    "chev-left": [
      '<path d="m15 18-6-6 6-6"/>'
    ],
    "chev-right": [
      '<path d="m9 18 6-6-6-6"/>'
    ]
  };

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;")
                    .replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /**
   * Render an icon as an inline SVG string.
   * @param {string} name - icon name (see CC.iconNames())
   * @param {string} [cls] - extra CSS class(es), merged onto the svg
   * @returns {string} inline <svg> markup
   */
  function icon(name, cls) {
    var parts = ICONS[name];
    if (!parts) {
      console.warn('[CraveCorner] Unknown icon: "' + name + '". Falling back to "warning".');
      parts = ICONS.warning;
    }
    var klass = "cc-icon" + (cls ? " " + esc(cls) : "");
    return '<svg class="' + klass + '" xmlns="http://www.w3.org/2000/svg" ' +
      'width="24" height="24" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true" focusable="false">' +
      parts.join("") +
      "</svg>";
  }

  /** @returns {string[]} all available icon names */
  function iconNames() {
    return Object.keys(ICONS);
  }

  CC.icon = icon;
  CC.iconNames = iconNames;
  CC.icons = ICONS;
})();
