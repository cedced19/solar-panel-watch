// Day-to-day navigation shared by the current-day and calendar pages: date
// arithmetic on YYYY-MM-DD keys, a horizontal swipe on touch screens that
// follows the finger, and the slide-in played when the next day appears.
(function () {
    const COMMIT_PX = 60; // horizontal travel that commits a swipe
    const LOCK_PX = 10; // travel before a gesture counts as horizontal or vertical
    const FOLLOW = 0.5; // share of the travel the content follows
    const MAX_FOLLOW_PX = 80;

    // `day` moved by `offset` days; calendar arithmetic, so no timezone is involved.
    function shiftDay(day, offset) {
        const [year, month, date] = day.split('-').map(part => parseInt(part, 10));
        return new Date(Date.UTC(year, month - 1, date + offset)).toISOString().slice(0, 10);
    }

    // True for a real calendar day written as YYYY-MM-DD.
    function isDay(value) {
        return /^\d{4}-\d{2}-\d{2}$/.test(value) && shiftDay(value, 0) === value;
    }

    // Swiping right brings the previous day, swiping left the next one.
    function swipeDirection(dx, dy) {
        if (Math.abs(dx) < COMMIT_PX || Math.abs(dx) < Math.abs(dy) * 1.5) return null;
        return dx > 0 ? 'prev' : 'next';
    }

    // A wide table keeps its own horizontal scroll instead of changing the day.
    function scrollsSideways(node, root) {
        for (; node && node !== root; node = node.parentElement) {
            if (node.scrollWidth > node.clientWidth + 1 &&
                /auto|scroll/.test(window.getComputedStyle(node).overflowX)) return true;
        }
        return false;
    }

    function drag(root, dx) {
        const shift = Math.max(-MAX_FOLLOW_PX, Math.min(MAX_FOLLOW_PX, dx * FOLLOW));
        root.style.transition = 'none';
        root.style.transform = shift ? 'translateX(' + shift + 'px)' : '';
        root.style.opacity = shift ? String(1 - Math.abs(shift) / (MAX_FOLLOW_PX * 3)) : '';
    }

    function release(root) {
        root.style.transition = '';
        root.style.transform = '';
        root.style.opacity = '';
    }

    // canSwipe(direction) says whether that day exists; onSwipe(direction) shows it.
    // direction is 'prev' or 'next'.
    function attach(root, {canSwipe, onSwipe}) {
        let touch = null;
        const offset = event => ({
            dx: event.changedTouches[0].clientX - touch.x,
            dy: event.changedTouches[0].clientY - touch.y
        });

        root.addEventListener('touchstart', event => {
            touch = event.touches.length === 1 && !scrollsSideways(event.target, root) ?
                {x: event.touches[0].clientX, y: event.touches[0].clientY, horizontal: null} : null;
        }, {passive: true});

        root.addEventListener('touchmove', event => {
            if (!touch) return;
            const {dx, dy} = offset(event);
            if (touch.horizontal === null && Math.max(Math.abs(dx), Math.abs(dy)) >= LOCK_PX) {
                touch.horizontal = Math.abs(dx) > Math.abs(dy);
            }
            if (!touch.horizontal) return;
            drag(root, canSwipe(dx > 0 ? 'prev' : 'next') ? dx : 0);
        }, {passive: true});

        root.addEventListener('touchend', event => {
            if (!touch) return;
            const {dx, dy} = offset(event);
            const direction = touch.horizontal ? swipeDirection(dx, dy) : null;
            touch = null;
            release(root);
            if (direction && canSwipe(direction)) onSwipe(direction);
        }, {passive: true});

        root.addEventListener('touchcancel', () => {
            touch = null;
            release(root);
        }, {passive: true});
    }

    // Slides `node` in from the side of the day it now shows.
    function slideIn(node, direction) {
        node.classList.remove('day-slide-prev', 'day-slide-next');
        void node.offsetWidth; // restart the animation
        node.classList.add('day-slide-' + direction);
    }

    window.daySwipe = {shiftDay, isDay, swipeDirection, attach, slideIn};
})();
