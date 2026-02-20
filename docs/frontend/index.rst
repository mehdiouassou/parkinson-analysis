Frontend
========

React/TypeScript application in ``web/``. Talks to the FastAPI backend over ``VITE_API_URL`` (default ``http://localhost:8000``).

Dev server
----------

.. code-block:: bash

   cd web
   npm install
   npm run dev

Production build
----------------

.. code-block:: bash

   cd web
   npm run build

Output goes to ``web/dist/``.
