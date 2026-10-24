const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function load() {
    const context = vm.createContext({window: {getComputedStyle: node => ({overflowX: node.overflowX || 'visible'})}});
    vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../assets/day-swipe.js'), 'utf8'), context,
        {filename: 'day-swipe.js'});
    return context.window.daySwipe;
}

function root() {
    const listeners = {};
    return {
        style: {}, listeners,
        addEventListener(type, listener) { listeners[type] = listener; }
    };
}

const point = (x, y) => ({clientX: x, clientY: y});
const touch = {
    start: (node, x, y, target = {}, touches = [point(x, y)]) => node.listeners.touchstart({touches, target}),
    move: (node, x, y) => node.listeners.touchmove({changedTouches: [point(x, y)]}),
    end: (node, x, y) => node.listeners.touchend({changedTouches: [point(x, y)]})
};

function attached(canSwipe = () => true) {
    const {attach} = load();
    const node = root();
    const swiped = [];
    attach(node, {canSwipe, onSwipe: direction => swiped.push(direction)});
    return {node, swiped};
}

test('shiftDay moves a day key across month, year and leap-day boundaries', () => {
    const {shiftDay} = load();
    assert.equal(shiftDay('2026-10-13', -1), '2026-10-12');
    assert.equal(shiftDay('2026-10-01', -1), '2026-09-30');
    assert.equal(shiftDay('2026-01-01', -1), '2025-12-31');
    assert.equal(shiftDay('2026-12-31', 1), '2027-01-01');
    assert.equal(shiftDay('2028-03-01', -1), '2028-02-29');
    assert.equal(shiftDay('2026-10-13', 0), '2026-10-13');
});

test('isDay accepts only real calendar days', () => {
    const {isDay} = load();
    assert.equal(isDay('2026-10-13'), true);
    assert.equal(isDay('2028-02-29'), true);
    for (const value of ['2026-02-30', '2026-13-01', '2026-1-1', 'yesterday', '', '2026-10-13T00:00']) {
        assert.equal(isDay(value), false, value);
    }
});

test('a swipe needs enough horizontal travel and a mostly horizontal direction', () => {
    const {swipeDirection} = load();
    assert.equal(swipeDirection(80, 0), 'prev');
    assert.equal(swipeDirection(-80, 10), 'next');
    assert.equal(swipeDirection(40, 0), null);
    assert.equal(swipeDirection(80, 70), null, 'a diagonal scroll is not a swipe');
    assert.equal(swipeDirection(-80, -50), 'next');
});

test('swiping right shows the previous day and swiping left the next, with the content following the finger', () => {
    const {node, swiped} = attached();
    touch.start(node, 100, 100);
    touch.move(node, 104, 101);
    assert.equal(node.style.transform, undefined, 'a few pixels do not start a drag');
    touch.move(node, 160, 105);
    assert.equal(node.style.transform, 'translateX(30px)');
    assert.equal(node.style.transition, 'none');
    assert.ok(Number(node.style.opacity) < 1);
    touch.end(node, 180, 105);
    assert.deepEqual(swiped, ['prev']);
    assert.equal(node.style.transform, '', 'the content is released');
    assert.equal(node.style.transition, '');

    touch.start(node, 200, 100);
    touch.move(node, 120, 100);
    touch.end(node, 120, 100);
    assert.deepEqual(swiped, ['prev', 'next']);
});

test('a short, vertical or cancelled gesture does not change the day', () => {
    const {node, swiped} = attached();
    touch.start(node, 100, 100);
    touch.move(node, 130, 100);
    touch.end(node, 130, 100);
    touch.start(node, 100, 100);
    touch.move(node, 105, 200);
    assert.equal(node.style.transform, '', 'a vertical scroll is not followed');
    touch.end(node, 190, 200);
    touch.start(node, 100, 100);
    touch.move(node, 200, 100);
    node.listeners.touchcancel();
    assert.equal(node.style.transform, '');
    assert.deepEqual(swiped, []);
});

test('a direction without a day neither moves the content nor swipes', () => {
    const {node, swiped} = attached(direction => direction === 'prev');
    touch.start(node, 200, 100);
    touch.move(node, 100, 100);
    assert.equal(node.style.transform, '');
    touch.end(node, 100, 100);
    assert.deepEqual(swiped, []);
    touch.start(node, 100, 100);
    touch.move(node, 200, 100);
    touch.end(node, 200, 100);
    assert.deepEqual(swiped, ['prev']);
});

test('multi-touch gestures and swipes starting in a horizontally scrolling element are left alone', () => {
    const {node, swiped} = attached();
    touch.start(node, 100, 100, {}, [point(100, 100), point(150, 100)]);
    touch.move(node, 200, 100);
    touch.end(node, 200, 100);
    const table = {scrollWidth: 900, clientWidth: 360, overflowX: 'auto'};
    touch.start(node, 100, 100, {scrollWidth: 50, clientWidth: 50, parentElement: table});
    touch.move(node, 200, 100);
    touch.end(node, 200, 100);
    assert.deepEqual(swiped, []);
    const fitting = {scrollWidth: 300, clientWidth: 300, overflowX: 'auto', parentElement: null};
    touch.start(node, 100, 100, {scrollWidth: 50, clientWidth: 50, parentElement: fitting});
    touch.move(node, 200, 100);
    touch.end(node, 200, 100);
    assert.deepEqual(swiped, ['prev']);
});

test('slideIn restarts the animation of the side the new day comes from', () => {
    const {slideIn} = load();
    const classes = new Set();
    const node = {
        classList: {add: name => classes.add(name), remove: (...names) => names.forEach(name => classes.delete(name))},
        offsetWidth: 1
    };
    slideIn(node, 'next');
    assert.deepEqual([...classes], ['day-slide-next']);
    slideIn(node, 'prev');
    assert.deepEqual([...classes], ['day-slide-prev']);
});
