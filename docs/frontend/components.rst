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
