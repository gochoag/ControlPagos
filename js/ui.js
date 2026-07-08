      function toggleMobileMenu() {
        document.getElementById("mobile-menu").classList.add("hidden");
      }

      function toggleSidebar() {
        const sidebar = document.getElementById("sidebar");
        sidebar.classList.toggle("hidden");
        sidebar.classList.toggle("flex");
      }

      function toggleThemeDropdown() {
        const dropdown = document.getElementById("theme-dropdown");
        const chevron = document.getElementById("theme-chevron");
        const isHidden = dropdown.classList.contains("hidden");
        dropdown.classList.toggle("hidden");
        chevron.style.transform = isHidden ? "rotate(180deg)" : "";
      }

      function toggleDriveMenu() {
        if (window.app && typeof window.app.toggleDriveMenu === "function") {
          window.app.toggleDriveMenu();
        }
      }

      function toggleBackupMenu() {
        if (window.app && typeof window.app.toggleBackupMenu === "function") {
          window.app.toggleBackupMenu();
        }
      }

      // Close theme dropdown when clicking outside
      document.addEventListener("click", function (e) {
        const btn = document.getElementById("theme-dropdown-btn");
        const dropdown = document.getElementById("theme-dropdown");
        if (!btn || !dropdown) return;
        if (!btn.contains(e.target) && !dropdown.contains(e.target)) {
          dropdown.classList.add("hidden");
          document.getElementById("theme-chevron").style.transform = "";
        }

        const driveBtn = document.getElementById("drive-menu-btn");
        const driveMenu = document.getElementById("drive-actions");
        if (driveBtn && driveMenu && !driveBtn.contains(e.target) && !driveMenu.contains(e.target)) {
          if (window.app && typeof window.app.closeDriveMenu === "function") {
            window.app.closeDriveMenu();
          }
        }

        const backupBtn = document.getElementById("backup-menu-btn");
        const backupMenu = document.getElementById("backup-actions");
        if (backupBtn && backupMenu && !backupBtn.contains(e.target) && !backupMenu.contains(e.target)) {
          if (window.app && typeof window.app.closeBackupMenu === "function") {
            window.app.closeBackupMenu();
          }
        }
      });
