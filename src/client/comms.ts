/**
 * Communications page glue: keep the conversation scrolled to the latest
 * message and toggle the context panel as a drawer on small screens.
 * Pure presentation — sending goes through the standard form POST.
 */
(() => {
  const scroll = document.getElementById("conv-scroll");
  if (scroll) scroll.scrollTop = scroll.scrollHeight;

  const toggle = document.getElementById("ctx-toggle");
  const ctx = document.getElementById("comms-ctx");
  if (toggle && ctx) {
    toggle.addEventListener("click", () => ctx.classList.toggle("open"));
  }
})();
