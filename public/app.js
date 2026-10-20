// Copy buttons and admin form presets; everything else works without JavaScript.
document.addEventListener('click', function (e) {
  var b = e.target.closest('[data-copy]');
  if (b) {
    navigator.clipboard.writeText(b.getAttribute('data-copy')).then(function () {
      var t = b.textContent; b.textContent = 'Copied!'; setTimeout(function () { b.textContent = t; }, 1500);
    });
  }
  var f = e.target.closest('[data-fill]');
  if (f) {
    var values = JSON.parse(f.getAttribute('data-fill'));
    Object.keys(values).forEach(function (k) { f.form.elements[k].value = values[k]; });
  }
});
