import type { AntiPattern } from "./anti-pattern-types";

export const IDIOMATIC_PATTERNS: readonly AntiPattern[] = [
  {
    id: "derived-state-as-use-state",
    title: "Derived state stored in useState",
    description:
      "Using useState + useEffect to compute a value that could be derived directly from existing state or props during render.",
    category: "idiomatic",
    languages: ["react"],
    badExample: `const [items, setItems] = useState(props.items);
const [filtered, setFiltered] = useState([]);
useEffect(() => {
  setFiltered(items.filter(i => i.active));
}, [items]);`,
    goodExample: `const filtered = props.items.filter(i => i.active);`,
    principle: "Derive, don't sync",
    detectionHint:
      "useState + useEffect pair where the effect only calls a setState with a value computable from props or other state. The derived value never has independent mutations.",
  },

  {
    id: "stale-closure-in-effect",
    title: "Stale closure in useEffect",
    description:
      "A useEffect that references state or props but omits them from the dependency array, reading stale values.",
    category: "idiomatic",
    languages: ["react"],
    badExample: `const [count, setCount] = useState(0);
useEffect(() => {
  const id = setInterval(() => setCount(count + 1), 1000);
  return () => clearInterval(id);
}, []);`,
    goodExample: `const [count, setCount] = useState(0);
useEffect(() => {
  const id = setInterval(() => setCount(c => c + 1), 1000);
  return () => clearInterval(id);
}, []);`,
    principle: "Hooks rules — exhaustive deps",
    detectionHint:
      "useEffect/useCallback/useMemo body references a variable from component scope that is absent from the dependency array.",
  },

  {
    id: "useeffect-as-event-handler",
    title: "useEffect as event handler",
    description:
      "Using useEffect to respond to a user action (click, submit) instead of handling it directly in the event handler.",
    category: "idiomatic",
    languages: ["react"],
    badExample: `const [submitted, setSubmitted] = useState(false);
useEffect(() => {
  if (submitted) { sendData(formData); }
}, [submitted]);
const handleSubmit = () => setSubmitted(true);`,
    goodExample: `const handleSubmit = () => { sendData(formData); };`,
    principle: "Effects are for synchronisation, not events",
    detectionHint:
      "useEffect triggered by a boolean flag state that is set in an event handler. The effect body performs a one-shot action (API call, navigation).",
  },

  {
    id: "prop-drilling",
    title: "Prop drilling",
    description:
      "Passing props through multiple intermediate components that do not use them, just to reach a deeply nested child.",
    category: "idiomatic",
    languages: ["react"],
    badExample: `function App({ theme }) {
  return <Layout theme={theme} />;
}
function Layout({ theme }) {
  return <Sidebar theme={theme} />;
}
function Sidebar({ theme }) {
  return <NavItem theme={theme} />;
}`,
    goodExample: `const ThemeContext = createContext<Theme>(defaultTheme);
function App({ theme }) {
  return <ThemeContext.Provider value={theme}><Layout /></ThemeContext.Provider>;
}
function NavItem() {
  const theme = useContext(ThemeContext);
}`,
    principle: "Prefer context or composition for cross-cutting concerns",
    detectionHint:
      "Same prop name passed through 3+ component levels without being used in intermediate components. Intermediate components just forward the prop.",
  },

  {
    id: "class-based-component",
    title: "New class-based React component",
    description:
      "Introducing a new class component when function components with hooks are the idiomatic standard.",
    category: "idiomatic",
    languages: ["react"],
    badExample: `class UserCard extends React.Component<Props> {
  render() {
    return <div>{this.props.name}</div>;
  }
}`,
    goodExample: `function UserCard({ name }: Props) {
  return <div>{name}</div>;
}`,
    principle: "Idiomatic React — prefer function components",
    detectionHint:
      "New class extending React.Component or React.PureComponent in added lines (not legacy code being modified).",
  },

  {
    id: "object-spread-for-optional-props",
    title: "Spread operator for optional prop forwarding",
    description:
      "Using object spread to forward all props to a child, making the component API opaque and fragile.",
    category: "idiomatic",
    languages: ["react"],
    badExample: `function Button({ label, ...rest }: ButtonProps) {
  return <button {...rest}>{label}</button>;
}`,
    goodExample: `function Button({ label, onClick, disabled, className }: ButtonProps) {
  return <button onClick={onClick} disabled={disabled} className={className}>{label}</button>;
}`,
    principle: "Explicit interfaces — name what you pass",
    detectionHint:
      "Rest spread (...rest or ...props) destructured from component parameters and spread onto a JSX element.",
  },

];
