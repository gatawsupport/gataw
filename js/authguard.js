// authguard.js - ENHANCED AUTH GUARD WITH ROLE-BASED ACCESS CONTROL

console.log("authguard.js loading...");

(function() {
  'use strict';

  // ==========================================
  // PAGE ACCESS MATRIX
  // ==========================================
  // Defines exactly which pages each role can visit.
  // Update this object whenever you add/remove pages.

  const PAGE_ACCESS = {
    guest: [
      '/html/dashboard.html',
      '/html/about.html'
    ],
    user: [
      '/html/dashboard.html',
      '/html/about.html',
      '/html/alerts.html',
      '/html/history.html',
      '/html/reports.html'
    ],
    admin: [
      '/html/dashboard.html',
      '/html/about.html',
      '/html/alerts.html',
      '/html/history.html',
      '/html/reports.html',
      '/html/systemConfig.html',
      '/html/admindashboard.html'
    ]
  };

  // Pages that never require authentication
  const PUBLIC_PAGES = [
    '/html/login.html',
    '/html/signup.html',
    '/forgot-password.html',
    '/html/forgotpassword.html',
    '/'
  ];

  // Default redirect per role when access is denied
  const ROLE_HOME = {
    guest: '/html/dashboard.html',
    user:  '/html/dashboard.html',
    admin: '/html/admindashboard.html'
  };

  // ==========================================
  // HELPERS
  // ==========================================

  function pageMatchesCurrent(page) {
    return window.location.pathname.endsWith(page);
  }

  function isPublicPage() {
    return PUBLIC_PAGES.some(pageMatchesCurrent);
  }

  function canRoleAccessPage(role, currentPath) {
    const allowed = PAGE_ACCESS[role] || [];
    return allowed.some(page => currentPath.endsWith(page));
  }

  function redirectHome(role) {
    const home = ROLE_HOME[role] || '/html/login.html';
    console.log(`⚠️ Access denied for role "${role}", redirecting to ${home}`);
    window.location.href = home;
  }

  // ==========================================
  // MAIN AUTH CHECK
  // ==========================================

  function checkAuth() {
    console.log("Checking authentication...");

    const currentPage = window.location.pathname;
    console.log("Current page:", currentPage);

    // Always allow public pages
    if (isPublicPage()) {
      console.log("✅ Public page, no auth required");
      return;
    }

    const userSession = localStorage.getItem('userSession');

    if (!userSession) {
      console.log("❌ No user session found, redirecting to login");
      window.location.href = '../html/login.html';
      return;
    }

    try {
      const session = JSON.parse(userSession);
      console.log("📋 User session:", session);

      // ── GUEST ──────────────────────────────
      if (session.isGuest === true) {
        console.log("🎭 Guest user detected");

        if (!canRoleAccessPage('guest', currentPage)) {
          redirectHome('guest');
          return;
        }

        console.log("✅ Guest access GRANTED for:", currentPage);
        return;
      }

      // ── AUTHENTICATED USER ─────────────────
      if (session.isLoggedIn && session.uid) {
        const userRole = session.role || 'user';
        console.log("✅ Authenticated user:", session.email, "| Role:", userRole);

        if (!canRoleAccessPage(userRole, currentPage)) {
          redirectHome(userRole);
          return;
        }

        console.log("✅ Access GRANTED for role:", userRole);
        return;

      } else {
        console.log("❌ Invalid session, redirecting to login");
        localStorage.removeItem('userSession');
        window.location.href = '../html/login.html';
      }

    } catch (error) {
      console.error("❌ Error parsing session:", error);
      localStorage.removeItem('userSession');
      window.location.href = '../html/login.html';
    }
  }

  // ==========================================
  // FIREBASE SESSION SYNC (non-guests only)
  // ==========================================

  function checkFirebaseAuth() {
    if (typeof firebase !== 'undefined' && firebase.auth) {
      firebase.auth().onAuthStateChanged((user) => {
        const userSession = localStorage.getItem('userSession');

        if (!user && userSession) {
          try {
            const session = JSON.parse(userSession);

            // Never clear guest sessions — they use anonymous Firebase auth
            if (!session.isGuest && session.isLoggedIn) {
              console.log("⚠️ Firebase session mismatch (non-guest), clearing localStorage");
              localStorage.removeItem('userSession');

              if (!isPublicPage()) {
                window.location.href = '../html/login.html';
              }
            }
          } catch (e) {
            console.error("Error parsing session during Firebase sync:", e);
          }
        }
      });
    }
  }

  // ==========================================
  // GLOBAL UTILITIES
  // ==========================================

  // Logout
  window.logout = async function() {
    console.log("Logging out...");
    try {
      localStorage.removeItem('userSession');
      if (typeof firebase !== 'undefined' && firebase.auth) {
        await firebase.auth().signOut();
        console.log("✅ Signed out from Firebase");
      }
      window.location.href = '../html/login.html';
    } catch (error) {
      console.error("Logout error:", error);
      localStorage.removeItem('userSession');
      window.location.href = '../html/login.html';
    }
  };

  // Get current user object from session
  window.getCurrentUser = function() {
    const userSession = localStorage.getItem('userSession');
    if (!userSession) return null;
    try {
      return JSON.parse(userSession);
    } catch (error) {
      console.error("Error parsing user session:", error);
      return null;
    }
  };

  // Role checks
  window.hasRole = function(role) {
    const user = window.getCurrentUser();
    if (!user) return false;
    if (user.isGuest && role === 'guest') return true;
    return user.role === role;
  };

  window.isAdmin = function() { return window.hasRole('admin'); };
  window.isUser  = function() { return window.hasRole('user');  };
  window.isGuest = function() {
    const user = window.getCurrentUser();
    return user && user.isGuest === true;
  };

  // Expose PAGE_ACCESS for nav rendering (used by nav-menu.js)
  window.PAGE_ACCESS = PAGE_ACCESS;

  // ==========================================
  // BOOT
  // ==========================================

  checkAuth();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
      setTimeout(checkFirebaseAuth, 500);
    });
  } else {
    setTimeout(checkFirebaseAuth, 500);
  }

  console.log("✅ authguard.js loaded");

})();