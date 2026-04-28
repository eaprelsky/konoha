import { Window } from "happy-dom";

const window = new Window({ url: "http://localhost/" });

// Set required globals for @testing-library/react
(globalThis as any).window = window;
(globalThis as any).document = window.document;
(globalThis as any).HTMLElement = window.HTMLElement;
(globalThis as any).Element = window.Element;
(globalThis as any).Node = window.Node;
(globalThis as any).Event = window.Event;
(globalThis as any).CustomEvent = window.CustomEvent;
(globalThis as any).DocumentFragment = window.DocumentFragment;
(globalThis as any).getSelection = () => null;
