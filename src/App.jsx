import { useApp } from './context/AppContext';
import HomePage from './pages/HomePage';
import MotionSetupPage from './pages/MotionSetupPage';
import SpeedControlPage from './pages/SpeedControlPage';
import CapturePage from './pages/CapturePage';
import MyShotsPage from './pages/MyShotsPage';
import VaultPage from './pages/CaptureVault';
import AiControlPage from './pages/AIControlPage';

export default function App() {
  const { page } = useApp();
  const isHome = page === 'home' || page === 'manual-control';

  return (
    <>
      {/* Cinematic focus background overlay */}
      <div 
        className={`fixed inset-0 pointer-events-none transition-all duration-700 ease-in-out z-[-1] ${
          !isHome ? 'bg-black/60 backdrop-blur-[3px]' : 'bg-black/0 backdrop-blur-0'
        }`}
      />

      <div className={`max-w-md mx-auto min-h-screen transition-all duration-700 ${!isHome ? 'page-focused' : ''}`}>
        {(page === 'home' || page === 'manual-control') && <HomePage />}
        {page === 'motion' && <MotionSetupPage />}
        {page === 'speed' && <SpeedControlPage />}
        {page === 'capture' && <CapturePage />}
        {page === 'shots' && <MyShotsPage />}
        {page === 'vault' && <VaultPage />}
        {page === 'ai-control' && <AiControlPage />}
      </div>
    </>
  );
}
