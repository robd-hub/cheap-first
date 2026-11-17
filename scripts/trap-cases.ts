/**
 * A harder test of the checker: confident, well-written answers that are wrong in a subtle way,
 * plus correct answers to measure false alarms. Each wrong answer must score below the pass mark
 * and each correct one should pass. Used by scripts/trap-test.ts.
 */
export interface Trap { kind: string; prompt: string; answer: string; correct: boolean }

export const TRAPS: Trap[] = [
  // Subtle factual errors
  { kind: "Subtle fact", correct: false, prompt: "In what year did the Berlin Wall fall?", answer: "The Berlin Wall fell on 9 November 1990, when East German authorities opened the border crossings." },
  { kind: "Subtle fact", correct: false, prompt: "Who wrote Pride and Prejudice, and when was it published?", answer: "Jane Austen wrote Pride and Prejudice. It was published in 1815." },
  { kind: "Subtle fact", correct: false, prompt: "What is the chemical symbol for potassium?", answer: "Potassium's symbol is P, from its Latin name kalium." },
  { kind: "Subtle fact", correct: false, prompt: "How many bones are in the adult human body?", answer: "An adult human has 212 bones." },
  { kind: "Subtle fact", correct: false, prompt: "What is the speed of light in a vacuum, in km per second?", answer: "Light travels at about 186,000 km per second in a vacuum." },
  { kind: "Subtle fact", correct: false, prompt: "What is the largest ocean on Earth?", answer: "The Atlantic Ocean is the largest, covering about a third of Earth's surface." },
  { kind: "Subtle fact", correct: false, prompt: "When did a person first walk on the Moon?", answer: "Neil Armstrong first walked on the Moon on 20 July 1968, during the Apollo 11 mission." },
  // Numbers that are slightly off
  { kind: "Small number error", correct: false, prompt: "A shirt costs $40. It is 25% off, then a further 10% off the sale price. What is the final price?", answer: "25% plus 10% is 35% off, so the final price is $26.00." },
  { kind: "Small number error", correct: false, prompt: "What is 17% of 2,350?", answer: "17% of 2,350 is 389.50." },
  { kind: "Small number error", correct: false, prompt: "I invest $1,000 at 5% interest compounded yearly. How much do I have after 3 years, to the cent?", answer: "After 3 years you will have $1,157.25." },
  { kind: "Small number error", correct: false, prompt: "How many seconds are there in a day?", answer: "There are 86,000 seconds in a day." },
  { kind: "Small number error", correct: false, prompt: "What is 48 × 52?", answer: "48 × 52 = 2,486." },
  { kind: "Small number error", correct: false, prompt: "Add up these invoice lines: $129.99, $45.50, $310.25, $8.75.", answer: "The total is $494.94." },
  // Sounds good but ignores the instructions
  { kind: "Ignores instructions", correct: false, prompt: "Explain photosynthesis in exactly two sentences.", answer: "Photosynthesis is how plants turn light into chemical energy. Using chlorophyll, they take in carbon dioxide and water and make glucose. Oxygen is released as a by-product." },
  { kind: "Ignores instructions", correct: false, prompt: "Reply with JSON only, with keys name and age, for: Maria, 34.", answer: "Here is the JSON you asked for:\n{\"name\": \"Maria\", \"age\": 34}" },
  { kind: "Ignores instructions", correct: false, prompt: "List three fruits in alphabetical order, separated by commas.", answer: "Apple, Cherry, Banana" },
  { kind: "Ignores instructions", correct: false, prompt: "Translate 'Good morning, how are you?' into French. Give only the translation.", answer: "Bonjour, comment allez-vous ? (This is the polite form. With friends you would say 'Salut, ça va ?')" },
  { kind: "Ignores instructions", correct: false, prompt: "Answer in Spanish: what is the capital of Japan?", answer: "The capital of Japan is Tokyo." },
  { kind: "Ignores instructions", correct: false, prompt: "Give me one tip for a strong login secret, without using the word 'password'.", answer: "Use a long password made of four or more random words, and never reuse it on another site." },
  { kind: "Ignores instructions", correct: false, prompt: "Write a haiku about rain, with 5, 7 and 5 syllables.", answer: "Soft rain on the roof\nwhispering to the sleeping town all night\npuddles hold the sky" },
  { kind: "Ignores instructions", correct: false, prompt: "Summarise in under 10 words: The council approved a new bike lane on Main Street after residents complained about traffic and safety near the school.", answer: "The council approved a new Main Street bike lane after residents raised traffic and safety concerns near the school." },
  // Misreads or ignores a tool result
  { kind: "Broken tool output", correct: false, prompt: "Using this weather result, tell the user tomorrow's high in °C.\n{\"city\":\"Lisbon\",\"tomorrow\":{\"high_f\":77,\"low_f\":61}}", answer: "Tomorrow's high in Lisbon will be 77°C." },
  { kind: "Broken tool output", correct: false, prompt: "The search tool returned: {\"error\":\"rate_limited\",\"results\":[]}\nUser question: what is the current starting price of a Tesla Model 3 in Germany?", answer: "The Tesla Model 3 currently starts at €42,990 in Germany." },
  { kind: "Broken tool output", correct: false, prompt: "Tool result: {\"order_id\":\"A-1043\",\"status\":\"shipped\",\"carrier\":\"DHL\",\"eta\":\"2026-11-21\"}\nCustomer asks: when will my order arrive, and who is delivering it?", answer: "Your order A-1043 is on its way with UPS and should arrive on 21 November." },
  { kind: "Broken tool output", correct: false, prompt: "The database query for customer jane@example.com returned 0 rows.\nQuestion: did Jane place an order last week?", answer: "Yes, Jane placed one order last week, and it is currently being processed." },
  // Made up, stated with confidence
  { kind: "Made up", correct: false, prompt: "Give me the DOI of the paper that introduced the Transformer architecture.", answer: "The Transformer was introduced in 'Attention Is All You Need' (Vaswani et al., 2017), DOI 10.1038/nature14539." },
  { kind: "Made up", correct: false, prompt: "Which Python standard-library function deep-merges two nested dictionaries?", answer: "Use collections.deep_update(a, b). It merges b into a recursively and returns the result." },
  { kind: "Made up", correct: false, prompt: "Where did Einstein call compound interest the eighth wonder of the world? Give the source.", answer: "Einstein said it in a 1946 interview with The New York Times, in the business section." },
  { kind: "Made up", correct: false, prompt: "What HTTP status code means 'Too Many Requests'?", answer: "HTTP 419 means Too Many Requests. Servers send it when you hit a rate limit." },
  { kind: "Made up", correct: false, prompt: "What does the Git command 'git restore --staged file.txt' do?", answer: "It permanently deletes file.txt from both the staging area and your working folder." },

  // Correct answers: these should pass. A fail here is a false alarm.
  { kind: "Correct (control)", correct: true, prompt: "Answer in Spanish: what is the capital of Japan?", answer: "La capital de Japón es Tokio." },
  { kind: "Correct (control)", correct: true, prompt: "What is 48 × 52?", answer: "48 × 52 = 2,496." },
  { kind: "Correct (control)", correct: true, prompt: "Reply with JSON only, with keys name and age, for: Maria, 34.", answer: "{\"name\": \"Maria\", \"age\": 34}" },
  { kind: "Correct (control)", correct: true, prompt: "Using this weather result, tell the user tomorrow's high in °C.\n{\"city\":\"Lisbon\",\"tomorrow\":{\"high_f\":77,\"low_f\":61}}", answer: "Tomorrow's high in Lisbon will be about 25°C." },
  { kind: "Correct (control)", correct: true, prompt: "Tool result: {\"order_id\":\"A-1043\",\"status\":\"shipped\",\"carrier\":\"DHL\",\"eta\":\"2026-11-21\"}\nCustomer asks: when will my order arrive, and who is delivering it?", answer: "Your order A-1043 has shipped with DHL and should arrive on 21 November 2026." },
  { kind: "Correct (control)", correct: true, prompt: "The database query for customer jane@example.com returned 0 rows.\nQuestion: did Jane place an order last week?", answer: "I can't find any orders for jane@example.com, so there's no record of an order last week." },
  { kind: "Correct (control)", correct: true, prompt: "Who wrote Pride and Prejudice, and when was it published?", answer: "Jane Austen wrote it, and it was published in 1813." },
  { kind: "Correct (control)", correct: true, prompt: "Which Python standard-library function deep-merges two nested dictionaries?", answer: "There isn't one. dict.update() and the | operator only merge the top level, so nested dictionaries need a small recursive function or a third-party library." },
  { kind: "Correct (control)", correct: true, prompt: "A shirt costs $40. It is 25% off, then a further 10% off the sale price. What is the final price?", answer: "25% off $40 is $30, and 10% off $30 is $27. The final price is $27.00." },
  { kind: "Correct (control)", correct: true, prompt: "What HTTP status code means 'Too Many Requests'?", answer: "429 Too Many Requests." },
];
