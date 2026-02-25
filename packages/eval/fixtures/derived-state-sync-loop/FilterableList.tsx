import { useState, useEffect } from "react";

interface Item { id: string; name: string; active: boolean }

function FilterableList({ items }: { items: Item[] }) {
  const [filtered, setFiltered] = useState<Item[]>([]);
  useEffect(() => {
    setFiltered(items.filter(i => i.active));
  }, [items]);
  const sorted = [...filtered].sort((a, b) => a.name.localeCompare(b.name));
  return <ul>{sorted.map(i => <li key={i.id}>{i.name}</li>)}</ul>;
}
