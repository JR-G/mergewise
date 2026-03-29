import type { KnowledgeDocument } from "../pipeline-types";

/**
 * Knowledge document for detecting prop drilling through intermediate components.
 *
 * @remarks
 * Draws from the React documentation on Context, Kent C. Dodds' writing on
 * component composition, and Dan Abramov's guidance on lifting state vs
 * pushing it down.
 */
export const PROP_DRILLING_KNOWLEDGE: KnowledgeDocument = {
  id: "prop-drilling",
  title: "Prop Drilling Through Intermediate Components",
  category: "clean",
  triggerSignals: ["has_hooks", "large_component", "high_import_count"],
  triggerClassifications: [
    "prop-drilling",
    "state-management",
    "component-complexity",
  ],
  fileExtensions: [".tsx", ".jsx"],
  content: `Prop drilling occurs when a prop is passed through multiple intermediate components that do not use it, solely to deliver it to a deeply nested consumer. The engineering cost is not the extra typing — it is that every intermediate component is now coupled to a prop it does not care about.

Detection criteria:
- A prop appears in a component's interface but is never read in that component's body — only forwarded to a child
- The same prop name appears in 3+ component signatures in a parent-child chain within the same file or closely related files
- A component's props interface contains fields that clearly belong to a different domain than the component's own responsibility (e.g. a Layout component accepting analyticsTrackingId)

Refactoring approaches:
- React Context: define a provider near the data source and consume it where needed, skipping intermediaries entirely
- Composition (children pattern): pass the fully-constructed child component as children or a render prop, so the intermediate component never sees the prop
- Custom hooks: extract the data-fetching or state logic into a hook that the consumer calls directly
- Component restructuring: sometimes drilling is a symptom of a component tree that is too deep — flattening the hierarchy removes the need to pass props through

When NOT to flag:
- Props passed through 1-2 levels — this is normal React data flow and the coupling cost is minimal
- Props that are genuinely used by every component in the chain (e.g. className, disabled)
- Small component trees (under 4 components total) where the full chain is visible in one file
- Callback props passed from parent to immediate child — this is standard event handling
- A class component at the leaf of the tree when the real design problem is the prop being threaded through unrelated intermediaries

The concrete cost must be specific: "Adding a new field to the user profile requires updating the props interface in 5 components that never read it" or "Removing the theme prop from NavItem cascades changes through Layout, Sidebar, and PageWrapper."`,
  examples: [
    {
      label: "Theme prop drilled through multiple layers, refactored to Context",
      scenario:
        "A theme configuration is defined at the App level but only consumed by NavItem, four levels deep. Every intermediate component must accept and forward the theme prop.",
      bad: `interface AppProps {
  initialTheme: Theme;
}

function App({ initialTheme }: AppProps) {
  const [theme, setTheme] = useState(initialTheme);
  return <Layout theme={theme} onThemeChange={setTheme} />;
}

function Layout({ theme, onThemeChange }: { theme: Theme; onThemeChange: (t: Theme) => void }) {
  return (
    <div>
      <Sidebar theme={theme} onThemeChange={onThemeChange} />
      <main>...</main>
    </div>
  );
}

function Sidebar({ theme, onThemeChange }: { theme: Theme; onThemeChange: (t: Theme) => void }) {
  return (
    <nav>
      <NavItem theme={theme} onThemeChange={onThemeChange} label="Home" href="/" />
      <NavItem theme={theme} onThemeChange={onThemeChange} label="Settings" href="/settings" />
    </nav>
  );
}

function NavItem({ theme, onThemeChange, label, href }: NavItemProps) {
  return (
    <a href={href} style={{ color: theme.primaryColour }}>
      {label}
      <button onClick={() => onThemeChange(nextTheme(theme))}>Toggle</button>
    </a>
  );
}`,
      good: `const ThemeContext = createContext<{
  theme: Theme;
  setTheme: (theme: Theme) => void;
} | null>(null);

function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}

function App({ initialTheme }: { initialTheme: Theme }) {
  const [theme, setTheme] = useState(initialTheme);
  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      <Layout />
    </ThemeContext.Provider>
  );
}

function Layout() {
  return (
    <div>
      <Sidebar />
      <main>...</main>
    </div>
  );
}

function Sidebar() {
  return (
    <nav>
      <NavItem label="Home" href="/" />
      <NavItem label="Settings" href="/settings" />
    </nav>
  );
}

function NavItem({ label, href }: { label: string; href: string }) {
  const { theme, setTheme } = useTheme();
  return (
    <a href={href} style={{ color: theme.primaryColour }}>
      {label}
      <button onClick={() => setTheme(nextTheme(theme))}>Toggle</button>
    </a>
  );
}`,
      explanation:
        "Layout and Sidebar no longer mention theme at all. Adding a new theme field only affects the provider and the consumers. Intermediate components are decoupled from a concern that was never theirs.",
    },
    {
      label:
        "User data drilled through multiple layers, refactored with composition",
      scenario:
        "A user object is passed from a page component through a card wrapper and a details section just to reach an avatar component. The intermediate components exist purely for layout.",
      bad: `function ProfilePage({ user }: { user: User }) {
  return (
    <div>
      <ProfileCard user={user} />
      <ActivityFeed userId={user.id} />
    </div>
  );
}

function ProfileCard({ user }: { user: User }) {
  return (
    <div className="card">
      <ProfileDetails user={user} />
      <ProfileStats followCount={user.followCount} />
    </div>
  );
}

function ProfileDetails({ user }: { user: User }) {
  return (
    <div>
      <Avatar src={user.avatarUrl} name={user.displayName} />
      <h2>{user.displayName}</h2>
    </div>
  );
}`,
      good: `function ProfilePage({ user }: { user: User }) {
  return (
    <div>
      <ProfileCard
        header={
          <ProfileDetails>
            <Avatar src={user.avatarUrl} name={user.displayName} />
            <h2>{user.displayName}</h2>
          </ProfileDetails>
        }
        stats={<ProfileStats followCount={user.followCount} />}
      />
      <ActivityFeed userId={user.id} />
    </div>
  );
}

function ProfileCard({ header, stats }: { header: ReactNode; stats: ReactNode }) {
  return (
    <div className="card">
      {header}
      {stats}
    </div>
  );
}

function ProfileDetails({ children }: { children: ReactNode }) {
  return <div>{children}</div>;
}`,
      explanation:
        "ProfileCard and ProfileDetails no longer know about the User type. The page component, which owns the user data, composes the tree directly. Adding a new user field only requires a change at the page level.",
    },
  ],
};
