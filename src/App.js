import React from 'react';
import ChatWidget from './ChatWidget';

function App() {
  return (
    <div style={styles.container}>
      <ChatWidget />
    </div>
  );
}

const styles = {
  container: {
    minHeight: '100vh',
    background: '#f0f2f5',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },
};

export default App;
