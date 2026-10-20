import type { StoreLocale } from "./locale";

const STRINGS = {
  en: {
    shopAll: "All products", allCategories: "All", addToCart: "Add to cart", unavailable: "Unavailable", from: "from",
    details: "Details", claims: "Good to know", previous: "Previous", next: "Next", noProducts: "No products published yet.",
    shipTo: "Ship to", page: "Page", of: "of", notTranslated: "Some details are shown in English.", back: "Back to shop",
  },
  de: {
    shopAll: "Alle Produkte", allCategories: "Alle", addToCart: "In den Warenkorb", unavailable: "Nicht verfügbar", from: "ab",
    details: "Details", claims: "Gut zu wissen", previous: "Zurück", next: "Weiter", noProducts: "Noch keine Produkte veröffentlicht.",
    shipTo: "Lieferung nach", page: "Seite", of: "von", notTranslated: "Einige Angaben werden auf Englisch angezeigt.", back: "Zurück zum Shop",
  },
  fr: {
    shopAll: "Tous les produits", allCategories: "Tout", addToCart: "Ajouter au panier", unavailable: "Indisponible", from: "à partir de",
    details: "Détails", claims: "Bon à savoir", previous: "Précédent", next: "Suivant", noProducts: "Aucun produit publié pour le moment.",
    shipTo: "Livraison vers", page: "Page", of: "sur", notTranslated: "Certains détails sont affichés en anglais.", back: "Retour à la boutique",
  },
} satisfies Record<StoreLocale, Record<string, string>>;

export type UiStrings = (typeof STRINGS)["en"];

export function t(locale: StoreLocale): UiStrings {
  return STRINGS[locale];
}

/** Option names come from the sheet in English; translate the common ones for display. */
const OPTION_NAMES: Record<StoreLocale, Record<string, string>> = {
  en: { size: "Size", color: "Colour", colour: "Colour", material: "Material" },
  de: { size: "Größe", color: "Farbe", colour: "Farbe", material: "Material" },
  fr: { size: "Taille", color: "Couleur", colour: "Couleur", material: "Matière" },
};

export function optionLabel(locale: StoreLocale, name: string): string {
  return OPTION_NAMES[locale][name.toLowerCase()] ?? name.charAt(0).toUpperCase() + name.slice(1);
}
