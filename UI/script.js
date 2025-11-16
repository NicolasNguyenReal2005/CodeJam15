document.addEventListener('DOMContentLoaded', function () {
    /* ---- scroll-triggered animations for Home ---- */
    const observer = new IntersectionObserver((entries, obs) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('is-visible');
                obs.unobserve(entry.target); // animate only once
            }
        });
    }, { threshold: 0.25 });

    document.querySelectorAll('.reveal-up, .reveal-right').forEach((el) => {
        observer.observe(el);
    });

    /* ---- fade nav buttons out on scroll ---- */
    const navLinksContainer = document.querySelector('.nav-links');
    window.addEventListener('scroll', () => {
        const y = window.scrollY || window.pageYOffset;
        if (y > 60) {
            navLinksContainer.classList.add('nav-links-faded');
        } else {
            navLinksContainer.classList.remove('nav-links-faded');
        }
    });

    /* ---- open / close chat overlay ---- */
    const overlay = document.getElementById('chat-overlay');
    const navLinks = document.querySelectorAll('.nav-link[data-target]');

    navLinks.forEach(link => {
        link.addEventListener('click', (e) => {
            const target = link.dataset.target;
            if (target === 'try') {
                e.preventDefault();
                overlay.classList.add('chat-overlay-open');
            } else if (target === 'home') {
                // just close overlay if open; don't scroll anywhere
                e.preventDefault();
                overlay.classList.remove('chat-overlay-open');
            }
        });
    });

    overlay.addEventListener('click', (e) => {
        if (e.target.dataset.close === 'true') {
            overlay.classList.remove('chat-overlay-open');
        }
    });

    /* ---- TRY NOBUL chat behavior ---- */
    const form = document.getElementById('chat-form');
    const input = document.getElementById('chat-input');
    const messages = document.getElementById('chat-messages');
    const chatAnalysis = document.getElementById('chat-analysis');

    // escape helper for any text coming from the backend
    function escapeHtml(str) {
        if (str === null || str === undefined) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    if (form && input && messages) {
        form.addEventListener('submit', async function (e) {
            e.preventDefault();
            const text = input.value.trim();
            if (!text) return;

            const safeText = escapeHtml(text);

            // Add user message bubble
            const userMsg = document.createElement('div');
            userMsg.className = 'chat-message chat-message-user';
            userMsg.innerHTML = `
                <div class="chat-message-label">You</div>
                <div class="chat-message-bubble">${safeText}</div>
            `;
            messages.appendChild(userMsg);

            // Assistant placeholder bubble
            const reply = document.createElement('div');
            reply.className = 'chat-message chat-message-assistant';
            reply.innerHTML = `
                <div class="chat-message-label">NOBUL</div>
                <div class="chat-message-bubble chat-message-placeholder">
                    Analyzing your argument for fallacies and credibility...
                </div>
            `;
            messages.appendChild(reply);
            messages.scrollTop = messages.scrollHeight;
            input.value = '';

            if (chatAnalysis) {
                chatAnalysis.textContent = "";
            }

            try {
                const resp = await fetch('http://127.0.0.1:8000/analyze', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    // backend now only expects { content }
                    body: JSON.stringify({ content: text })
                });

                if (!resp.ok) {
                    throw new Error('Server error ' + resp.status);
                }

                const data = await resp.json();

                // Build a compact, readable analysis (same info as the extension)
                const container = document.createElement('div');
                container.className = 'analysis-results';

                // Credibility
                if (typeof data.credibility_score !== 'undefined') {
                    const scoreEl = document.createElement('div');
                    scoreEl.innerHTML =
                        `<strong>Credibility Score:</strong> ${data.credibility_score}/100`;
                    container.appendChild(scoreEl);

                    if (data.notes) {
                        const notesEl = document.createElement('div');
                        notesEl.style.marginTop = '6px';
                        notesEl.innerHTML =
                            `<strong>Summary:</strong> ${escapeHtml(data.notes)}`;
                        container.appendChild(notesEl);
                    }
                }

                // Fallacies
                if (Array.isArray(data.fallacies) && data.fallacies.length > 0) {
                    const headerEl = document.createElement('div');
                    headerEl.style.marginTop = '10px';
                    headerEl.innerHTML = '<strong>Fallacies detected:</strong>';
                    container.appendChild(headerEl);

                    data.fallacies.forEach(f => {
                        const fWrap = document.createElement('div');
                        fWrap.style.marginTop = '6px';

                        const type = escapeHtml(f.type || 'Fallacy');
                        const expl = escapeHtml(f.explanation || '');

                        fWrap.innerHTML = `<em>${type}</em>: ${expl}`;

                        if (f.quote) {
                            const qEl = document.createElement('div');
                            qEl.style.marginTop = '4px';
                            qEl.style.opacity = '0.85';
                            qEl.textContent = `Quote: "${f.quote}"`;
                            fWrap.appendChild(qEl);
                        }

                        container.appendChild(fWrap);
                    });
                } else {
                    const noFall = document.createElement('div');
                    noFall.style.marginTop = '8px';
                    noFall.textContent =
                        'No clear logical fallacies were identified in this excerpt.';
                    container.appendChild(noFall);
                }

                // Swap placeholder for real content
                const bubble = reply.querySelector('.chat-message-bubble');
                if (bubble) {
                    bubble.classList.remove('chat-message-placeholder');
                    bubble.innerHTML = '';
                    bubble.appendChild(container);
                }

                messages.scrollTop = messages.scrollHeight;
            } catch (err) {
                console.error('Analysis error', err);
                const bubble = reply.querySelector('.chat-message-bubble');
                if (bubble) {
                    bubble.classList.remove('chat-message-placeholder');
                    bubble.textContent =
                        'Error contacting the NOBUL analysis server. Is it running?';
                }
            }
        });
    }
});
