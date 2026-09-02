import { type TranslatedLanguages, type TranslationKeys, Translations } from './data/languages';

const defaultLocale: TranslatedLanguages = 'en';
let locale: TranslatedLanguages | undefined;

function getBrowserLocale() {
  return navigator.language.split('-')[0];
}

export function translateElement(element: Element) {
  if (!(element instanceof HTMLElement) || !locale) return;

  const prop = element.getAttribute('data-trans');

  if (prop) {
    const key = (element.getAttribute(prop) || '').trim();
    if (key && key in Translations[locale]) {
      element.setAttribute(prop, Translations[locale][key as TranslationKeys]);
    }
  } else {
    const key = element.innerText.trim();
    if (key && key in Translations[locale]) {
      element.innerText = Translations[locale][key as TranslationKeys];
    }
  }
}

function translatePage() {
  document.querySelectorAll('[data-trans]').forEach(translateElement);
}

export function translateTree(root: ParentNode): void {
  root.querySelectorAll('[data-trans]').forEach(translateElement);
}

export function setLocale(newLocale: string) {
  if (newLocale === locale) return;

  const newLocaleLower = newLocale.toLocaleLowerCase();

  locale = newLocaleLower in Translations ? (newLocaleLower as TranslatedLanguages) : defaultLocale;
  document.documentElement.lang = locale;
  translatePage();
}

export function initializeLocale() {
  const browserLocale = getBrowserLocale();
  setLocale(browserLocale);
}
