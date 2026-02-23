import React, { useState, useCallback } from "react";

interface Todo { id: string; text: string; done: boolean }

const TodoItem = React.memo(function TodoItem({
  todo, onToggle
}: { todo: Todo; onToggle: (id: string) => void }) {
  return <li onClick={() => onToggle(todo.id)}>{todo.text}</li>;
});

function TodoRow({ todo }: { todo: Todo }) {
  return <tr><td>{todo.text}</td><td>{todo.done ? "Done" : "Pending"}</td></tr>;
}

function TodoList({ todos }: { todos: Todo[] }) {
  const [items, setItems] = useState(todos);

  return (
    <div>
      <ul>
        {items.map(t => (
          <TodoItem key={t.id} todo={t} onToggle={(id) => {
            setItems(prev => prev.map(i => i.id === id ? { ...i, done: !i.done } : i));
          }} />
        ))}
      </ul>
      <table>
        {items.map(t => <TodoRow key={t.id} todo={t} />)}
      </table>
    </div>
  );
}
