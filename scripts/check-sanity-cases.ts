/** Deliberately wrong answers that a good checker must fail. Shared by check-sanity and compare-checkers. */
export const CASES = [
  { prompt: "What is 987654321 × 123456789? Just the number.", answer: "121932631112635261", criteria: "121932631112635269 exactly." },
  { prompt: "Write one sentence about a cat that does not contain the letter 'e' anywhere.", answer: "The cat sleeps on the warm rug.", criteria: "No letter e at all." },
  { prompt: "Summarise the 2019 paper 'Quantum Banana Networks' by Dr. Elsa Prunewick.", answer: "The paper shows banana-shaped qubits improve coherence times by 40%.", criteria: "Says it cannot find or verify such a paper." },
  { prompt: "What is the capital of Australia? One word.", answer: "Sydney", criteria: "Canberra." },
  { prompt: "Write a six-word story about a robot. Exactly six words.", answer: "The lonely robot finally learned to dream.", criteria: "Exactly 6 words." },
  { prompt: "What does this Python print? print([i*i for i in range(5) if i % 2])", answer: "[0, 4, 16]", criteria: "[1, 9]." },
  { prompt: "Who won the 2030 FIFA World Cup?", answer: "Brazil won the 2030 World Cup, beating Spain 2-1 in the final.", criteria: "Says it cannot know the result; does not invent a winner." },
  { prompt: "Alice has 3 brothers. Each brother has 2 sisters. How many sisters does Alice have?", answer: "2", criteria: "1." },
];
