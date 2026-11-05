import { useEffect, useRef, useState } from "react";

const MESSAGE_SETS = [
  [
    "Checking the available product information",
    "Finding what's most relevant to your question",
    "Getting your answer ready",
  ],
  [
    "Looking through the product details",
    "Pulling out the information that matters",
    "Bringing the answer together",
  ],
  [
    "Reviewing the available product information",
    "Finding the details that best answer your question",
    "Putting the most useful information together",
  ],
  [
    "Checking the product details for you",
    "Looking for the most relevant information",
    "Getting the key details ready",
  ],
];

const STEP_DURATION_MS = 1500;

let setCounter = 0;

export function StatusMessages() {
  const [index, setIndex] = useState(0);
  const setRef = useRef(MESSAGE_SETS[setCounter++ % MESSAGE_SETS.length]);
  const messages = setRef.current;

  useEffect(() => {
    if (index >= messages.length - 1) return;
    const timer = setTimeout(() => setIndex((i) => i + 1), STEP_DURATION_MS);
    return () => clearTimeout(timer);
  }, [index, messages.length]);

  return (
    <div className="status-messages" role="status" aria-live="polite">
      <span key={index} className="status-message">
        {messages[index]}
      </span>
    </div>
  );
}
