// Existing artwork + lightweight animated UI cues. No video, timers or network.
const ART = {
    welcome: { file: 'welcome', width: 96, height: 120 },
    record: { file: 'empty', width: 112, height: 112 },
    review: { file: 'gmail', width: 96, height: 96 },
    confirmed: { file: 'gmail', width: 112, height: 112 }
};
const MARKS = {
    welcome: '<path class="mascot-ink" d="M5 9h14M5 15h10"/><path class="mascot-tick" d="m6 23 4 4 12-12"/>',
    record: '<path class="mascot-ink" d="M5 10h17M5 17h12M5 24h9"/><path class="mascot-pencil" d="m17 20 7-7 3 3-7 7-4 1z"/>',
    review: '<path d="M7 3h14v25H7zM10 9h8M10 14h8M10 19h5"/><path class="mascot-scan" d="M2 5h25"/>',
    confirmed: '<circle cx="15" cy="15" r="12"/><path class="mascot-tick" d="m8 15 5 5 10-11"/>'
};
let observer;
let initialized = false;
const interactions = new WeakMap();

function decorate(scene) {
    if (scene.dataset.mascotReady) return;
    const role = Object.hasOwn(ART, scene.dataset.mascot) ? scene.dataset.mascot : 'welcome';
    scene.dataset.mascot = role;
    scene.dataset.mascotReady = 'true';
    scene.setAttribute('aria-hidden', 'true');
    const cue = document.createElement('span');
    cue.className = 'mascot-cue';
    cue.innerHTML = `<svg viewBox="0 0 30 32" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${MARKS[role]}</svg>`;
    scene.append(cue);
    observer?.observe(scene);
}

export function createMascotScene(role = 'record') {
    const art = ART[role] || ART.record;
    const scene = document.createElement('span');
    scene.className = 'mascot-scene';
    scene.dataset.mascot = role;
    const image = document.createElement('img');
    image.src = `/images/konteo-guide-${art.file}.jpg`;
    image.width = art.width;
    image.height = art.height;
    image.alt = '';
    image.loading = 'lazy';
    scene.append(image);
    decorate(scene);
    return scene;
}

export function mountMascots(root = document) {
    root.querySelectorAll('.mascot-scene').forEach(decorate);
}

export function releaseMascots(root) {
    root?.querySelectorAll('.mascot-scene').forEach(scene => {
        observer?.unobserve(scene);
        const image = scene.querySelector('img');
        if (image) interactions.get(image)?.cancel();
    });
}

export function reactMascot(root) {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const scene = root?.querySelector('.mascot-scene');
    const image = scene?.querySelector('img');
    if (!image || !scene.getClientRects().length || !image.animate) return;
    interactions.get(image)?.cancel();
    interactions.set(image, image.animate([
        { transform: 'translateY(0) rotate(0)' },
        { transform: 'translateY(-5px) rotate(-2deg)', offset: .35 },
        { transform: 'translateY(-2px) rotate(1deg)', offset: .7 },
        { transform: 'translateY(0) rotate(0)' }
    ], { duration: 620, easing: 'cubic-bezier(.2,.7,.3,1)' }));
}

export function initMascots() {
    if (initialized) return;
    initialized = true;
    if ('IntersectionObserver' in window) {
        observer = new window.IntersectionObserver(entries => {
            entries.forEach(({ target, isIntersecting }) => {
                // Unobserve after one entrance, so scrolling never restarts a loop.
                if (!target.isConnected) { observer.unobserve(target); return; }
                if (isIntersecting) {
                    target.classList.add('mascot-arrived');
                    observer.unobserve(target);
                }
            });
        }, { threshold: .4 });
    }
    mountMascots();
    window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', event => {
        if (!event.matches) return;
        document.querySelectorAll('.mascot-scene img').forEach(image => {
            interactions.get(image)?.cancel();
        });
    });
    document.addEventListener('toggle', event => {
        if (event.target.matches?.('.companion-help') && event.target.open) reactMascot(event.target);
    }, true);
    document.addEventListener('pointerover', event => {
        if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
        const summary = event.target.closest('.companion-help > summary');
        if (summary && !summary.contains(event.relatedTarget)) reactMascot(summary.parentElement);
    });
    document.addEventListener('focusin', event => {
        const summary = event.target.closest('.companion-help > summary');
        if (summary) reactMascot(summary.parentElement);
    });
}
