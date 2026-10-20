// Restaurant setup for the demo. Edit names, prices and stations here.
// Prices are from public menu photos of Crafty Dee's; confirm with the restaurant before showing them.

export const RESTAURANT = "Crafty Dee's";
// Short permanent id for this restaurant. Diner accounts work across restaurants; their visits are
// labelled with this id so each restaurant only ever looks at its own guests.
export const RESTAURANT_ID = "craftydees";
export const TABLE_COUNT = 10;

// Placeholder staff names. Replace with the restaurant's real waiters.
export const WAITERS = [
  { id: "w1", name: "Grace" },
  { id: "w2", name: "Baraka" },
  { id: "w3", name: "Juma" },
];

// Each menu section sends its items to one station screen.
export const STATIONS = { kitchen: "Kitchen", bar: "Bar", grill: "Fired Up Grill" };

const T = (label, price) => [label, price];
const BEER = (taste, half, full, tower) =>
  [T("Taste", taste), T("Half 250ml", half), T("Full 400ml", full)].concat(tower ? [T("Tower", tower)] : []);

export const MENU = [
  { c: "On tap", st: "bar", items: [
    { n: "Light Lager", m: "ABV 3.2%", v: BEER(2000, 6000, 9000, 70000) },
    { n: "Pilsner", m: "ABV 4.6% · Silver, African Beer Cup", v: BEER(2000, 7000, 10000, 80000) },
    { n: "Blonde Ale", m: "ABV 4.5%", v: BEER(2000, 7000, 10000, 80000) },
    { n: "Pale Ale", m: "ABV 4.5%", v: BEER(3000, 8000, 11000, 85000) },
    { n: "IPA", m: "ABV 6%", v: BEER(4000, 10000, 13000, 100000) },
    { n: "Wheat Beer", m: "ABV 4.5% · Gold, African Beer Cup", v: BEER(3000, 8000, 11000, 85000) },
    { n: "Double IPA", m: "ABV 8%", v: BEER(5000, 12000, 16000) },
    { n: "Apple Cider", m: "ABV 4%", v: BEER(3000, 8000, 11000) },
    { n: "SMaSH Lager", m: "ABV 4.5% · New", v: BEER(3000, 8000, 11000, 85000) },
    { n: "Festbier", m: "ABV 4.6% · New", v: BEER(3000, 7000, 10000, 80000) },
  ]},
  { c: "Cocktails", st: "bar", items: [
    { n: "Passion Gin Fizz", d: "Double gin, passion juice, sugar, lemon, soda", v: [T("", 15000)] },
    { n: "Caipirinha", d: "Double white rum, lemon, sugar", v: [T("", 15000)] },
    { n: "Mai Tai", d: "Dark and white rum, pineapple, sugar, lemon", v: [T("", 15000)] },
    { n: "Whiskey Sour", d: "Double Jameson, egg white, lemon, sugar", v: [T("", 15000)] },
    { n: "Mojito", d: "Double rum, lime, mint, soda", v: [T("Classic", 20000), T("Strawberry", 20000), T("Passion", 20000)] },
    { n: "Lagerita", d: "Triple sec, double tequila, lemon, Light Lager", v: [T("", 15000)] },
    { n: "Blue Lagoon", d: "Double vodka, blue curaçao", v: [T("", 15000)] },
    { n: "Dee's Tin", d: "Blue curaçao, Malibu, pineapple, sugar, lemon", v: [T("", 18000)] },
    { n: "Gin / Vodka Martini", v: [T("Gin", 15000), T("Vodka", 15000)] },
    { n: "Vodka Amarula Martini", d: "Vodka, Kahlúa, Amarula", v: [T("", 20000)] },
  ]},
  { c: "Pub grub", st: "kitchen", items: [
    { n: "Fish & Chips", v: [T("", 21000)] },
    { n: "Chicken Tenders", d: "With chips", v: [T("", 18000)] },
    { n: "Quesadilla", v: [T("Chicken", 18000), T("Pork", 18000), T("Mutton", 18000), T("Veg", 16000)] },
    { n: "Calamari Rings", v: [T("Grilled", 16000), T("Fried", 16000)] },
    { n: "Buffalo Wings", v: [T("", 15000)] },
    { n: "TZ Cassava Tots", m: "Vegetarian", v: [T("", 12000)] },
    { n: "Buffalo Cauliflower", m: "Vegetarian", v: [T("", 10000)] },
    { n: "Beer Battered Zucchini Fritters", m: "Vegetarian", v: [T("", 9000)] },
  ]},
  { c: "Burgers & pizza", st: "kitchen", items: [
    { n: "Minced Lamb Burger", v: [T("", 20000)] },
    { n: "Minced Chicken Burger", v: [T("", 18000)] },
    { n: "Pizza Margarita", m: "Vegetarian", v: [T("", 15000)] },
    { n: "Pizza Vegetarian", m: "Vegetarian", v: [T("", 18000)] },
    { n: "Pizza Chicken", v: [T("Chicken", 20000), T("Buffalo chicken", 20000)] },
    { n: "Pizza Smoked Pork Belly", v: [T("", 20000)] },
  ]},
  { c: "Sandwiches & bowls", st: "kitchen", items: [
    { n: "Pork Belly Panini", d: "Smoked pork belly, cheese, pickles, mustard", v: [T("", 18000)] },
    { n: "Mushroom & Spinach Panini", d: "Mushroom, peppers, spinach, goat cheese", v: [T("", 18000)] },
    { n: "Spicy Chicken Panini", d: "Grilled chicken, avocado, chipotle", v: [T("", 18000)] },
    { n: "Sesame Seared Tuna Bowl", d: "Tuna, avocado, rice, ponzu", v: [T("", 18000)] },
    { n: "Bread Crusted Chicken Bowl", v: [T("Brown rice", 18000), T("White rice", 18000)] },
    { n: "Vegan Bowl", d: "Chickpeas, veg, avocado, tahini", v: [T("Brown rice", 15000), T("White rice", 15000)] },
  ]},
  { c: "Salads & sharing", st: "kitchen", items: [
    { n: "Greek Salad", v: [T("", 18000)] },
    { n: "Chicken Caesar", v: [T("", 18000)] },
    { n: "Mango Salad", v: [T("", 12000)] },
    { n: "Meat Platter", d: "Wings, sheekh kebab, tenders, pork quesadillas, chips", v: [T("", 60000)] },
    { n: "Seafood Platter", d: "Calamari, fish skewers, fish fingers, prawns, chips", v: [T("", 50000)] },
    { n: "Veg Platter", v: [T("", 40000)] },
  ]},
  { c: "Sides & sweet", st: "kitchen", items: [
    { n: "Chips", v: [T("", 3000)] },
    { n: "Coleslaw", v: [T("", 3000)] },
    { n: "Garlic Bread", v: [T("", 5000)] },
    { n: "Ice Cream", v: [T("", 10000)] },
    { n: "Apple Crumble", d: "With vanilla ice cream · about 30 min", v: [T("", 15000)] },
  ]},
  { c: "Fired Up Grill", st: "grill", items: [
    { n: "Beef Nundu", v: [T("", 12000)] },
    { n: "Beef Wrap", v: [T("", 15000)] },
    { n: "Cheesy Chips", v: [T("", 12000)] },
    { n: "Half Tandoori Chicken", d: "With chips", v: [T("", 18000)] },
    { n: "Pepper Steak", v: [T("Chips", 30000), T("Mash", 30000)] },
    { n: "Grilled Sirloin", v: [T("Chips", 45000), T("Mash", 45000)] },
  ]},
];
