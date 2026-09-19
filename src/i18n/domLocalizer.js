import { normalizeLanguage, translateUiText } from './translator.js';

const LOCALIZED_ATTRIBUTES = ['title', 'placeholder', 'aria-label', 'alt'];
const IGNORED_SELECTOR = [
  'script',
  'style',
  'code',
  'pre',
  '[data-i18n-ignore]',
  '[contenteditable="true"]',
].join(',');

const elementOf = (node) => (
  node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement
);

const isIgnored = (node) => Boolean(elementOf(node)?.closest(IGNORED_SELECTOR));

/**
 * 与 `isIgnored` 同义，但把结果记在调用方给的 Map 里。
 *
 * `closest` 要沿 DOM 一路走到 body，每层还要匹配一个多项复合选择器。一批
 * mutation 里同一个容器会反复出现（终端每帧重建它所有的行），逐条重算是
 * 这个回调里最贵的一笔。缓存只在单次回调内有效 —— 那期间 DOM 不会再变，
 * 所以不存在失效问题。
 */
const isIgnoredCached = (node, cache) => {
  const element = elementOf(node);
  if (!element) return false;
  const hit = cache.get(element);
  if (hit !== undefined) return hit;
  const result = Boolean(element.closest(IGNORED_SELECTOR));
  cache.set(element, result);
  return result;
};

export class DomLocalizer {
  constructor(root, language) {
    this.root = root;
    this.language = normalizeLanguage(language);
    this.textState = new WeakMap();
    this.attributeState = new WeakMap();
    this.observer = new MutationObserver((mutations) => this.handleMutations(mutations));
    this.observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: LOCALIZED_ATTRIBUTES,
    });
    this.translateTree(root);
  }

  setLanguage(language) {
    const next = normalizeLanguage(language);
    if (next === this.language) return;
    this.language = next;
    this.translateTree(this.root);
  }

  disconnect() {
    this.observer.disconnect();
  }

  translateTextNode(node, ignoreCache) {
    if (ignoreCache ? isIgnoredCached(node, ignoreCache) : isIgnored(node)) return;
    const current = node.nodeValue;
    const previous = this.textState.get(node);
    const source = previous && current === previous.rendered ? previous.source : current;
    const rendered = translateUiText(source, this.language);
    this.textState.set(node, { source, rendered });
    if (rendered !== current) node.nodeValue = rendered;
  }

  translateAttributes(element, ignoreCache) {
    if (ignoreCache ? isIgnoredCached(element, ignoreCache) : isIgnored(element)) return;
    let states = this.attributeState.get(element);
    if (!states) {
      states = new Map();
      this.attributeState.set(element, states);
    }
    for (const attribute of LOCALIZED_ATTRIBUTES) {
      if (!element.hasAttribute(attribute)) continue;
      const current = element.getAttribute(attribute);
      const previous = states.get(attribute);
      const source = previous && current === previous.rendered ? previous.source : current;
      const rendered = translateUiText(source, this.language);
      states.set(attribute, { source, rendered });
      if (rendered !== current) element.setAttribute(attribute, rendered);
    }
  }

  translateTree(node, ignoreCache) {
    if (node.nodeType === Node.TEXT_NODE) {
      this.translateTextNode(node, ignoreCache);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    // 根节点落在忽略子树里就整棵跳过，省掉下面那趟 TreeWalker
    if (ignoreCache ? isIgnoredCached(node, ignoreCache) : isIgnored(node)) return;
    this.translateAttributes(node, ignoreCache);
    const walker = document.createTreeWalker(
      node,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    );
    let current = walker.nextNode();
    while (current) {
      // 子节点仍要各自判定：子树内部可能还嵌着 code / pre / 另一个
      // data-i18n-ignore。缓存让这些判定基本都落在同一批已知结果上。
      if (current.nodeType === Node.TEXT_NODE) this.translateTextNode(current, ignoreCache);
      else this.translateAttributes(current, ignoreCache);
      current = walker.nextNode();
    }
  }

  handleMutations(mutations) {
    // 整批共用一份「这个元素在不在忽略子树里」的判定缓存。回调执行期间
    // DOM 不会再变，所以缓存不会过期；而一批里同一个容器反复出现是常态
    // （终端每帧重建它所有的行），逐条重跑 closest 是这里最贵的一笔。
    const ignoreCache = new Map();
    for (const mutation of mutations) {
      if (mutation.type === 'characterData') {
        this.translateTextNode(mutation.target, ignoreCache);
      } else if (mutation.type === 'attributes') {
        this.translateAttributes(mutation.target, ignoreCache);
      } else {
        for (const node of mutation.addedNodes) this.translateTree(node, ignoreCache);
      }
    }
  }
}

