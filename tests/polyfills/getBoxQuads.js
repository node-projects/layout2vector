/**
 * Minimal getBoxQuads polyfill for test environments.
 * Falls back to getBoundingClientRect to produce DOMQuad objects.
 * ONLY for use in tests — never bundled in production.
 */
(function () {
  if (typeof Element === "undefined") return;
  if (typeof Element.prototype.getBoxQuads === "function") return;

  Element.prototype.getBoxQuads = function (options) {
    var box = (options && options.box) || "border";
    var rect = this.getBoundingClientRect();

    // For content box, adjust by padding
    if (box === "content") {
      var cs = getComputedStyle(this);
      var pt = parseFloat(cs.paddingTop) || 0;
      var pr = parseFloat(cs.paddingRight) || 0;
      var pb = parseFloat(cs.paddingBottom) || 0;
      var pl = parseFloat(cs.paddingLeft) || 0;
      var bt = parseFloat(cs.borderTopWidth) || 0;
      var br = parseFloat(cs.borderRightWidth) || 0;
      var bb = parseFloat(cs.borderBottomWidth) || 0;
      var bl = parseFloat(cs.borderLeftWidth) || 0;
      rect = {
        left: rect.left + pl + bl,
        top: rect.top + pt + bt,
        right: rect.right - pr - br,
        bottom: rect.bottom - pb - bb,
        width: rect.width - pl - pr - bl - br,
        height: rect.height - pt - pb - bt - bb,
      };
    }

    var quad = new DOMQuad(
      new DOMPoint(rect.left, rect.top),
      new DOMPoint(rect.right, rect.top),
      new DOMPoint(rect.right, rect.bottom),
      new DOMPoint(rect.left, rect.bottom)
    );

    return [quad];
  };
})();
