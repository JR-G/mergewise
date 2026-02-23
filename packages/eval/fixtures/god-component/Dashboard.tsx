function Dashboard() {
  const [users, setUsers] = useState([]);
  const [metrics, setMetrics] = useState(null);
  useEffect(() => { fetchUsers().then(setUsers) }, []);
  useEffect(() => { fetchMetrics().then(setMetrics) }, []);
  const filtered = users.filter(u => u.active);
  const sorted = filtered.sort((a, b) => a.name.localeCompare(b.name));
  return <div>{sorted.map(u => <Card key={u.id} user={u} />)}{metrics && <Chart data={metrics} />}</div>;
}
