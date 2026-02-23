import React from "react";

interface Theme { primary: string; secondary: string }

function App({ theme }: { theme: Theme }) {
  return <Layout theme={theme} />;
}

function Layout({ theme }: { theme: Theme }) {
  return (
    <div>
      <Sidebar theme={theme} />
    </div>
  );
}

function Sidebar({ theme }: { theme: Theme }) {
  return <NavItem theme={theme} />;
}

class NavItem extends React.Component<{ theme: Theme }> {
  render() {
    return <span style={{ color: this.props.theme.primary }}>Home</span>;
  }
}
