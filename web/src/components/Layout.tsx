import { NavLink, Outlet } from 'react-router-dom';
import { useState, useEffect } from 'react';

const navItems = [
  {
    path: '/',
    label: 'Camera Feeds',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 10.5l4.72-4.72a.75.75 0 011.28.53v11.38a.75.75 0 01-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 002.25-2.25v-9a2.25 2.25 0 00-2.25-2.25h-9A2.25 2.25 0 002.25 7.5v9a2.25 2.25 0 002.25 2.25z" />
      </svg>
    )
  },
  {
    path: '/conversion',
    label: 'Conversion',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
      </svg>
    )
  },
  {
    path: '/tagging',
    label: 'Tagging',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9.568 3H5.25A2.25 2.25 0 003 5.25v4.318c0 .597.237 1.17.659 1.591l9.581 9.581c.699.699 1.78.872 2.607.33a18.095 18.095 0 005.223-5.223c.542-.827.369-1.908-.33-2.607L11.16 3.66A2.25 2.25 0 009.568 3z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M6 6h.008v.008H6V6z" />
      </svg>
    )
  },
  { 
    path: '/processing', 
    label: 'Processing',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 3v1.5M4.5 8.25H3m18 0h-1.5M4.5 12H3m18 0h-1.5m-15 3.75H3m18 0h-1.5M8.25 19.5V21M12 3v1.5m0 15V21m3.75-18v1.5m0 15V21m-9-1.5h10.5a2.25 2.25 0 002.25-2.25V6.75a2.25 2.25 0 00-2.25-2.25H6.75A2.25 2.25 0 004.5 6.75v10.5a2.25 2.25 0 002.25 2.25zm.75-12h9v9h-9v-9z" />
      </svg>
    )
  },
  { 
    path: '/filemanager', 
    label: 'File Manager',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
      </svg>
    )
  },
];

// Icons - thin outlined style
const SunIcon = () => (
  <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v2.25m6.364.386l-1.591 1.591M21 12h-2.25m-.386 6.364l-1.591-1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z" />
  </svg>
);

const MoonIcon = () => (
  <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" d="M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z" />
  </svg>
);

export default function Layout() {
  const [darkMode, setDarkMode] = useState(() => {
    try {
      const saved = localStorage.getItem('darkMode');
      return saved ? JSON.parse(saved) : false;
    } catch {
      return false;
    }
  });

  useEffect(() => {
    localStorage.setItem('darkMode', JSON.stringify(darkMode));
    if (darkMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [darkMode]);

  return (
    <div className="h-screen flex flex-col bg-clinical-bg dark:bg-clinical-dark-bg transition-colors overflow-hidden">
      {/* Navigation header - compact for smaller screens */}
      <nav className="bg-white dark:bg-clinical-dark-card border-b border-clinical-border dark:border-clinical-dark-border flex-shrink-0">
        <div className="px-4 xl:px-6">
          <div className="flex items-center justify-between h-14">
            {/* Logo and title */}
            <div className="flex items-center gap-3">
              {/* Simple medical cross - flat, professional */}
              <div className="w-9 h-9 bg-clinical-blue rounded-md flex items-center justify-center flex-shrink-0">
                <svg className="w-5 h-5 text-white" fill="currentColor" viewBox="0 0 20 20">
                  <path d="M8 3h4v14H8V3zm-5 5h14v4H3V8z" />
                </svg>
              </div>
              <div className="hidden sm:block">
                <h1 className="text-lg font-bold text-clinical-text-primary dark:text-clinical-text-dark leading-tight">
                  Parkinson Analysis
                </h1>
                <p className="text-sm text-clinical-text-secondary dark:text-clinical-text-dark-secondary leading-tight">
                  Pose &amp; Tremor Analysis
                </p>
              </div>
            </div>

            {/* Navigation menu */}
            <div className="flex items-center gap-0.5">
              {navItems.map((item) => (
                <NavLink
                  key={item.path}
                  to={item.path}
                  className={({ isActive }: { isActive: boolean }) =>
                    `flex items-center gap-1.5 px-3 py-2 rounded text-sm font-medium transition-colors ${
                      isActive
                        ? 'bg-clinical-blue text-white'
                        : 'text-clinical-text-secondary dark:text-clinical-text-dark-secondary hover:bg-clinical-bg dark:hover:bg-clinical-dark-bg hover:text-clinical-blue'
                    }`
                  }
                >
                  {item.icon}
                  <span className="hidden lg:inline">{item.label}</span>
                </NavLink>
              ))}
              
              {/* Dark mode toggle */}
              <button
                onClick={() => setDarkMode(!darkMode)}
                className="ml-1 p-2 rounded text-clinical-text-secondary dark:text-clinical-text-dark-secondary hover:bg-clinical-bg dark:hover:bg-clinical-dark-bg hover:text-clinical-blue transition-colors border border-clinical-border dark:border-clinical-dark-border"
                aria-label="Toggle dark mode"
              >
                {darkMode ? <SunIcon /> : <MoonIcon />}
              </button>
            </div>
          </div>
        </div>
      </nav>

      {/* Page content - scrollable, fills remaining space */}
      <main className="flex-1 overflow-auto px-4 xl:px-6 py-4">
        <Outlet />
      </main>

      {/* Footer - compact */}
      <footer className="border-t border-clinical-border dark:border-clinical-dark-border flex-shrink-0">
        <div className="px-4 xl:px-6 py-2">
          <p className="text-center text-sm text-clinical-text-secondary dark:text-clinical-text-dark-secondary">
            Parkinson Analysis &middot;{' '}
            <a
              href="https://github.com/mehdiouassou"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-clinical-blue transition-colors"
            >
              Mehdi Ouassou
            </a>
          </p>
        </div>
      </footer>
    </div>
  );
}
