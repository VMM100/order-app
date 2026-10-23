// Generic photos for menu items, by item name. Free-licence photos from Pexels (pexels.com/license),
// resized to 320px and stored in img/. A photo the owner uploads for an item always takes priority,
// and items not listed here simply show no photo.
const P = {
  lager: ["Light Lager", "Pilsner", "SMaSH Lager"],
  "golden-beer": ["Blonde Ale", "Wheat Beer", "Festbier", "Apple Cider"],
  "amber-beer": ["Pale Ale", "IPA"],
  "dark-beer": ["Double IPA"],
  mojito: ["Mojito", "Caipirinha"],
  "lime-cocktail": ["Passion Gin Fizz", "Lagerita", "Blue Lagoon", "Dee's Tin"],
  "mint-cocktail": ["Mai Tai", "Whiskey Sour"],
  martini: ["Gin / Vodka Martini", "Vodka Amarula Martini"],
  "fish-chips": ["Fish & Chips"],
  "chicken-strips": ["Chicken Tenders", "Bread Crusted Chicken Bowl"],
  quesadilla: ["Quesadilla"],
  wings: ["Buffalo Wings"],
  fries: ["Chips", "TZ Cassava Tots", "Cheesy Chips"],
  burger: ["Minced Lamb Burger", "Minced Chicken Burger"],
  "pizza-margherita": ["Pizza Margarita"],
  pizza: ["Pizza Vegetarian", "Pizza Chicken", "Pizza Smoked Pork Belly"],
  panini: ["Pork Belly Panini", "Mushroom & Spinach Panini", "Spicy Chicken Panini"],
  "poke-bowl": ["Sesame Seared Tuna Bowl"],
  "greek-salad": ["Greek Salad", "Veg Platter"],
  "green-salad": ["Chicken Caesar", "Vegan Bowl"],
  "meat-platter": ["Meat Platter"],
  "ice-cream": ["Ice Cream"],
  steak: ["Pepper Steak"],
  sirloin: ["Grilled Sirloin"],
  tandoori: ["Half Tandoori Chicken"],
};
const BY_NAME = {};
Object.entries(P).forEach(([file, names]) => names.forEach((n) => (BY_NAME[n.toLowerCase()] = `img/${file}.jpg`)));
// Smart quotes and straight quotes match the same item.
export const genericPhoto = (name) => BY_NAME[String(name || "").toLowerCase().replace(/[’‘]/g, "'").trim()] || null;
