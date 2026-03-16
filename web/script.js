/* ─── Mobile Nav Toggle ──────────────────────── */
const navToggle = document.getElementById('navToggle');
const navLinks = document.getElementById('navLinks');

navToggle.addEventListener('click', () => {
  navLinks.classList.toggle('open');
  navToggle.textContent = navLinks.classList.contains('open') ? '\u2715' : '\u2630';
});

// Close nav when a link is clicked
navLinks.querySelectorAll('a').forEach(link => {
  link.addEventListener('click', () => {
    navLinks.classList.remove('open');
    navToggle.textContent = '\u2630';
  });
});

/* ─── Scroll Fade-In Animations ──────────────── */
const fadeElements = document.querySelectorAll('.fade-in');

const observer = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add('visible');
      observer.unobserve(entry.target);
    }
  });
}, { threshold: 0.1, rootMargin: '0px 0px -40px 0px' });

fadeElements.forEach(el => observer.observe(el));

/* ─── Live Reputation Score ──────────────────── */
async function fetchReputation() {
  try {
    const res = await fetch('https://api.toppa.cc/reputation');
    if (!res.ok) return;
    const data = await res.json();
    const el = document.getElementById('reputationScore');
    if (el && data.score !== undefined) {
      el.textContent = data.score.toFixed(1);
    }
  } catch {
    // API unreachable — leave as dash
  }
}

fetchReputation();
