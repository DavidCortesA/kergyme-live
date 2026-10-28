const q = new URLSearchParams(location.search);
document.getElementById('num').textContent = q.get('n') || '';
document.getElementById('label').textContent = q.get('label') || '';
document.getElementById('res').textContent = `${q.get('res') || ''} · pantalla ${q.get('n')} de ${q.get('total')}`;
// Un clic "navega" y el proceso principal cierra todos los patrones.
document.addEventListener('click', () => { location.href = 'about:blank'; });
