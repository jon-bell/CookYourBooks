import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

import { installClickTracking, trackRoute } from './breadcrumbs.js';
import { installConsoleCapture } from './consoleTail.js';

/**
 * Starts the two global breadcrumb sources and records route changes.
 *
 * Mounted once at the app root. Renders nothing — it exists so the trail is
 * complete by construction rather than depending on every screen remembering
 * to instrument itself.
 */
export function BreadcrumbTracker() {
  const location = useLocation();

  useEffect(() => {
    const stopClicks = installClickTracking();
    const stopConsole = installConsoleCapture();
    return () => {
      stopClicks();
      stopConsole();
    };
  }, []);

  useEffect(() => {
    trackRoute(location.pathname + location.search);
  }, [location.pathname, location.search]);

  return null;
}
