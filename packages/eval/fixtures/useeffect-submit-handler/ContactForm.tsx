import { useState, useEffect } from "react";

function ContactForm() {
  const [name, setName] = useState("");
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (submitted) {
      try {
        sendEmail({ name });
      } catch (err) {
        console.error(err.message);
      }
      setSubmitted(false);
    }
  }, [submitted]);

  const handleSubmit = () => setSubmitted(true);

  return (
    <form onSubmit={handleSubmit}>
      <input value={name} onChange={e => setName(e.target.value)} />
      <button type="submit">Send</button>
    </form>
  );
}
