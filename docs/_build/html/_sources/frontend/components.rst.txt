Components
==========

Toast
-----

.. js:module:: src/components/Toast

Global notification system. Wrap the app with ``ToastProvider`` to enable it.

.. js:function:: ToastProvider({ children })

   :param ReactNode children: Child components.

.. js:function:: useToast()

   :returns: ``{ showToast: (message, type) => void }``

   .. code-block:: tsx

      const { showToast } = useToast();
      showToast('Saved', 'success');

.. js:class:: ToastContextType

   .. js:attribute:: showToast

      :type: (message: string, type?: 'success' | 'error' | 'info') => void

Layout
------

.. js:module:: src/components/Layout

.. js:function:: Layout()

   Application shell with sidebar navigation.

   - Links to CameraFeeds, Tagging, Processing, FileManager
   - Dark mode toggle — persists to ``localStorage``

ErrorBoundary
-------------

.. js:module:: src/components/ErrorBoundary

.. js:class:: ErrorBoundary

   React component that catches JavaScript errors anywhere in their child component tree,
   logs those errors, and displays a fallback UI instead of the component tree that crashed.

   **State**

   .. js:attribute:: hasError

      ``boolean`` — True if an error has been caught.

   .. js:attribute:: error

      ``Error | null`` — The error object.
