Frontend: Components (UI)
=========================

Reusable UI components used throughout the application.

Toast
-----

.. js:module:: src/components/Toast

The Toast system provides global notification capabilities.

.. js:function:: ToastProvider({ children })
   
   Context provider that must wrap the application to enable toasts.
   Manages the state of active toast messages.

   :param ReactNode children: Child components.

.. js:function:: useToast()
   
   Custom hook to access the toast context.

   :returns: ``{ showToast: (message, type) => void }``

   **Usage Example:**

   .. code-block:: tsx

      const { showToast } = useToast();
      showToast('Saved successfully', 'success');

.. js:class:: ToastContextType

   .. js:attribute:: showToast

      :type: (message: string, type?: 'success' | 'error' | 'info') => void

      Function to display a temporary notification.

Layout
------

.. js:module:: src/components/Layout

.. js:function:: Layout()

   The main application shell. Renders the sidebar navigation and the main content area.

   **Features:**
   
   * **Navigation**: Links to CameraFeeds, Tagging, Processing, and FileManager.
   * **Dark Mode**: Toggles ``dark`` class on the ``<html>`` element and persists preference to ``localStorage``.
   * **Responsive**: Adapts layout for different screen sizes.
