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

const isIgnored = (node) => {
  const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  return Boolean(element?.closest(IGNORED_SELECTOR));
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

  translateTextNode(node) {
    if (isIgnored(node)) return;
    const current = node.nodeValue;
    const previous = this.textState.get(node);
    const source = previous && current === previous.rendered ? previous.source : current;
    const rendered = translateUiText(source, this.language);
    this.textState.set(node, { source, rendered });
    if (rendered !== current) node.nodeValue = rendered;
  }

  translateAttributes(element) {
    if (isIgnored(element)) return;
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

  translateTree(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      this.translateTextNode(node);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE || isIgnored(node)) return;
    this.translateAttributes(node);
    const walker = document.createTreeWalker(
      node,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    );
    let current = walker.nextNode();
    while (current) {
      if (current.nodeType === Node.TEXT_NODE) this.translateTextNode(current);
      else this.translateAttributes(current);
      current = walker.nextNode();
    }
  }

  handleMutations(mutations) {
    for (const mutation of mutations) {
      if (mutation.type === 'characterData') {
        this.translateTextNode(mutation.target);
      } else if (mutation.type === 'attributes') {
        this.translateAttributes(mutation.target);
      } else {
        for (const node of mutation.addedNodes) this.translateTree(node);
      }
    }
  }
}

