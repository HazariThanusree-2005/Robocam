import { createContext, useContext, useState, useCallback } from 'react';

const AppContext = createContext(null);

export const DEFAULT_MOTION = {
  startAngle: -45,
  endAngle: 45,
  delay: 30,
  pauseDuration: 2,
  preset: null,
};

export function AppProvider({ children }) {
  const [page, setPageInternal] = useState('home');
  const [prevPage, setPrevPage] = useState('home');
  const [motion, setMotion] = useState(DEFAULT_MOTION);
  const [esp32IP, setESP32IP] = useState(() => localStorage.getItem('esp32_ip') || '');
  const [currentPreset, setCurrentPreset] = useState(null);

  const setPage = useCallback((newPage) => {
    setPageInternal(current => {
      setPrevPage(current);
      return newPage;
    });
  }, []);

  const updateMotion = useCallback((updates) => {
    setMotion(prev => ({ ...prev, ...updates }));
  }, []);

  const updateESP32IP = useCallback((ip) => {
    setESP32IP(ip);
    localStorage.setItem('esp32_ip', ip);
  }, []);

  return (
    <AppContext.Provider value={{ page, setPage, prevPage, motion, updateMotion, esp32IP, updateESP32IP, currentPreset, setCurrentPreset }}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}
