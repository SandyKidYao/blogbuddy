import * as assert from 'assert';
import { BlockInfo, buildSequence, changeItems, changeRatio, diffText, locate, SeqItem } from '../../core/blockDiff';

const p = (text: string, type = 'paragraph'): BlockInfo => ({ type, text, sig: text });
const kinds = (seq: SeqItem[]): string => seq.map(item => item.kind).join(' ');
const accept = (seq: SeqItem[], index: number): void => {
    seq[index].state = 'accepted';
    const twin = seq[index].link;
    if (twin !== undefined) { seq[twin].state = 'accepted'; }
};

suite('blockDiff', () => {
    const A = p('上周写一篇关于缓存失效的文章，写到一半想确认一个说法。');
    const B = p('其实说实话，我个人觉得，写作最宝贵的东西其实并不是时间本身，而是那种可以持续往下写的状态。');
    const B2 = p('写作最宝贵的不是时间，而是能持续往下写的状态。');
    const C = p('有人做过统计，说人被打断之后要二十多分钟才能回来。');
    const D = p('更麻烦的是，打断不一定来自别人。');
    const N = p('聊天框的毛病正在这里：每问一次，就得离开文档一次。');

    test('text diff marks a typo fix without touching the rest', () => {
        const segs = diffText('我想要的协做方式', '我想要的协作方式');
        assert.deepStrictEqual(segs, [{ t: '=', s: '我想要的协' }, { t: '-', s: '做' }, { t: '+', s: '作' }, { t: '=', s: '方式' }]);
        assert.ok(changeRatio(segs) < 0.3);
    });
    test('a lone shared character between two changes is folded into the change', () => {
        const segs = diffText('非常的好', '相当的棒');
        assert.deepStrictEqual(segs, [{ t: '-', s: '非常的好' }, { t: '+', s: '相当的棒' }]);
    });
    test('a heavy rewrite reports a high change ratio', () => {
        assert.ok(changeRatio(diffText(B.text, B2.text)) > 0.3);
    });
    test('identical blocks produce no decisions', () => {
        assert.deepStrictEqual(changeItems(buildSequence([A, B], [A, B])), []);
    });
    test('a rewritten block is a modification, not a delete plus an add', () => {
        assert.strictEqual(kinds(buildSequence([A, B, C], [A, B2, C])), 'keep mod keep');
    });
    test('an unrelated replacement is a delete and an add', () => {
        assert.strictEqual(kinds(buildSequence([A, C], [A, N])), 'keep del add');
    });
    test('added and removed blocks keep their reading position', () => {
        assert.strictEqual(kinds(buildSequence([A, B, C], [A, N, B])), 'keep add keep del');
    });
    test('a block that reappears elsewhere is a move, linked both ways', () => {
        const seq = buildSequence([A, B, C, D], [A, D, B, C]);
        assert.strictEqual(kinds(seq), 'keep to keep keep from');
        assert.strictEqual(seq[1].link, 4);
        assert.strictEqual(seq[4].link, 1);
        assert.strictEqual(seq[1].dir, 'up');
        assert.deepStrictEqual(changeItems(seq), [1]);
    });
    test('a long paragraph that was rewritten stays put while the short one that changed places moves', () => {
        const seq = buildSequence([B, C, D], [D, B2, N]);
        assert.strictEqual(kinds(seq), 'to mod del from add');
    });
    test('every pending item is located in an untouched document', () => {
        const basis = [B, C, D], target = [D, B2, N];
        const seq = buildSequence(basis, target);
        const placed = locate(seq, basis, target, basis);
        assert.deepStrictEqual(placed.get(0), { at: 2, insertAt: 0 });   // D moves to the top
        assert.deepStrictEqual(placed.get(1), { at: 0 });                // B is rewritten in place
        assert.deepStrictEqual(placed.get(2), { at: 1 });                // C is removed
        assert.deepStrictEqual(placed.get(4), { insertAt: 3 });          // N goes at the end
    });

    /** What the editor does when the writer accepts one item. */
    function applyItem(seq: SeqItem[], basis: BlockInfo[], target: BlockInfo[], current: BlockInfo[], index: number): BlockInfo[] {
        const place = locate(seq, basis, target, current).get(index);
        assert.ok(place, `item ${index} (${seq[index].kind}) should be placeable`);
        const item = seq[index], next = [...current];
        if (item.kind === 'mod') { next[place.at!] = target[item.new!]; }
        else if (item.kind === 'del') { next.splice(place.at!, 1); }
        else if (item.kind === 'add') { next.splice(place.insertAt!, 0, target[item.new!]); }
        else if (item.kind === 'to') {
            next.splice(place.insertAt!, 0, target[item.new!]);
            next.splice(place.at! + (place.at! >= place.insertAt! ? 1 : 0), 1);
        }
        accept(seq, index);
        return next;
    }
    function permutations<T>(list: T[]): T[][] {
        return list.length <= 1 ? [list] : list.flatMap((head, i) => permutations([...list.slice(0, i), ...list.slice(i + 1)]).map(rest => [head, ...rest]));
    }
    const X = p('新增的第一段，讲的是提问不离开正文。'), Y = p('新增的第二段，讲的是回答不进正文。');
    const cases: Array<[string, BlockInfo[], BlockInfo[]]> = [
        ['move + rewrite + add + delete', [B, C, D], [D, B2, N]],
        ['two adds in a row', [A, C], [A, X, Y, C]],
        ['add at the start and at the end', [A, B], [X, A, B, Y]],
        ['everything replaced', [A, C], [X, Y]],
        ['delete at both ends', [A, B, C, D], [B, C]],
        ['move down past a rewrite', [D, B, C], [B2, C, D]],
        ['split one block into two', [B], [B2, N]],
        ['from nothing', [], [X, Y]],
    ];
    for (const [name, basis, target] of cases) {
        test(`accepting in any order reaches the proposed text: ${name}`, () => {
            for (const order of permutations(changeItems(buildSequence(basis, target)))) {
                const seq = buildSequence(basis, target);
                let current = [...basis];
                for (const index of order) { current = applyItem(seq, basis, target, current, index); }
                assert.deepStrictEqual(current.map(block => block.text), target.map(block => block.text), `order ${order.join(',')}`);
                assert.strictEqual(locate(seq, basis, target, current).size, 0);
            }
        });
    }
    test('an add lands after an add accepted before it', () => {
        const basis = [A, C], target = [A, X, Y, C];
        const seq = buildSequence(basis, target);
        assert.strictEqual(kinds(seq), 'keep add add keep');
        accept(seq, 1);
        assert.deepStrictEqual(locate(seq, basis, target, [A, X, C]).get(2), { insertAt: 2 });
    });
    test('an item whose block the writer edited is not placed, others still are', () => {
        const basis = [A, B, C], target = [A, B2];
        const seq = buildSequence(basis, target);
        assert.strictEqual(kinds(seq), 'keep mod del');
        const placed = locate(seq, basis, target, [A, p('我自己又改了这一段。'), C]);
        assert.ok(!placed.has(1));
        assert.deepStrictEqual(placed.get(2), { at: 2 });
    });
    test('blocks the writer added inside the scope are left alone', () => {
        const basis = [A, B], target = [A, B2];
        const seq = buildSequence(basis, target);
        assert.deepStrictEqual(locate(seq, basis, target, [A, p('我新写的一段。'), B]).get(1), { at: 2 });
    });
    test('formatting-only changes count as a modification', () => {
        const bold: BlockInfo = { type: 'paragraph', text: A.text, sig: `strong:${A.text}` };
        assert.strictEqual(kinds(buildSequence([A], [bold])), 'mod');
    });
});
