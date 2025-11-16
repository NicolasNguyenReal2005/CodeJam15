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

    /* ---- chat stub behavior in overlay ---- */
    const form = document.getElementById('chat-form');
    const input = document.getElementById('chat-input');
    const messages = document.getElementById('chat-messages');

    // small helper to safely escape HTML when inserting server content
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

            const safeText = text.replace(/</g, "&lt;").replace(/>/g, "&gt;");

            // Add user message
            const userMsg = document.createElement('div');
            userMsg.className = 'chat-message chat-message-user';
            userMsg.innerHTML = `
                <div class="chat-message-label">You</div>
                <div class="chat-message-bubble">${safeText}</div>
            `;
            messages.appendChild(userMsg);

            // Assistant placeholder while analyzing
            const reply = document.createElement('div');
            reply.className = 'chat-message chat-message-assistant';
            reply.innerHTML = `
                <div class="chat-message-label">NOBUL</div>
                <div class="chat-message-bubble chat-message-placeholder">Analyzing...</div>
            `;
            messages.appendChild(reply);
            messages.scrollTop = messages.scrollHeight;
            input.value = '';

            // Call backend analyze endpoint
            try {
                const resp = await fetch('http://127.0.0.1:8000/analyze', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ mode: 'text', content: text })
                });

                if (!resp.ok) {
                    throw new Error('Server error ' + resp.status);
                }

                const data = await resp.json();

                // Render results into the assistant bubble (similar to popup.js)
                const contentDiv = document.createElement('div');
                contentDiv.className = 'analysis-results';

                // Credibility
                if (typeof data.credibility_score !== 'undefined') {
                    const score = document.createElement('div');
                    score.innerHTML = `<strong>Credibility Score:</strong> ${data.credibility_score}/100`;
                    contentDiv.appendChild(score);
                    if (data.notes) {
                        const notes = document.createElement('div');
                        notes.style.marginTop = '6px';
                        notes.innerHTML = `<strong>Notes:</strong> ${escapeHtml(data.notes)}`;
                        contentDiv.appendChild(notes);
                    }
                }

                // Fallacies
                if (Array.isArray(data.fallacies) && data.fallacies.length > 0) {
                    const fallHeader = document.createElement('div');
                    fallHeader.style.marginTop = '8px';
                    fallHeader.innerHTML = '<strong>Fallacies:</strong>';
                    contentDiv.appendChild(fallHeader);

                    data.fallacies.forEach(f => {
                        const fdiv = document.createElement('div');
                        fdiv.style.marginTop = '6px';
                        fdiv.innerHTML = `<em>${escapeHtml(f.type || 'Fallacy')}</em>: ${escapeHtml(f.explanation || '')}`;
                        if (f.quote) {
                            const q = document.createElement('div');
                            q.style.opacity = '0.85';
                            q.style.marginTop = '4px';
                            q.innerHTML = `Quote: \"${escapeHtml(f.quote)}\"`;
                            fdiv.appendChild(q);
                        }
                        contentDiv.appendChild(fdiv);
                    });
                } else {
                    const nofall = document.createElement('div');
                    nofall.style.marginTop = '8px';
                    nofall.textContent = 'No clear fallacy detected.';
                    contentDiv.appendChild(nofall);
                }

                // AI-generated likelihood
                if (data.ai_generated_likelihood) {
                    const ai = document.createElement('div');
                    ai.style.marginTop = '8px';
                    ai.innerHTML = `<strong>AI-Generated Likelihood:</strong> ${escapeHtml(data.ai_generated_likelihood)}`;
                    contentDiv.appendChild(ai);
                }

                // Replace placeholder bubble with results
                const bubble = reply.querySelector('.chat-message-bubble');
                if (bubble) {
                    bubble.classList.remove('chat-message-placeholder');
                    bubble.innerHTML = '';
                    bubble.appendChild(contentDiv);
                }

                messages.scrollTop = messages.scrollHeight;
            } catch (err) {
                console.error('Analysis error', err);
                const bubble = reply.querySelector('.chat-message-bubble');
                if (bubble) {
                    bubble.classList.remove('chat-message-placeholder');
                    bubble.textContent = 'Error contacting analysis server.';
                }
            }
        });
    }
});