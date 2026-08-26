import { useCallback, useEffect, useMemo, useState } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { DocumentDrawer } from "./components/DocumentDrawer";
import { SearchPalette } from "./components/SearchPalette";
import { DailyHotPage } from "./pages/DailyHotPage";
import { GraphPage } from "./pages/GraphPage";
import { BooksPage } from "./pages/BooksPage";
import { OverviewPage } from "./pages/OverviewPage";
import { SystemPage } from "./pages/SystemPage";
import { TopicsPage } from "./pages/TopicsPage";
import { CareerPage } from "./pages/CareerPage";
import { StockWatchlistPage } from "./pages/StockWatchlistPage";
import { PromptsLibraryPage } from "./pages/PromptsLibraryPage";
import { useVaultSync } from "./hooks/useVaultSync";

const localWorkbench = import.meta.env.VITE_WORKBENCH_HOSTED !== "true";

export function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchOpen, setSearchOpen] = useState(false);
  const [selectedDocumentId, setSelectedDocumentId] = useState(null);
  const [readerContext, setReaderContext] = useState(null);
  const vaultSync = useVaultSync(location.pathname);
  // key 只含 vault revision：路由切换走 Router 正常协调（不整树重建），
  // 仅当 vault 文件变化（revision 递增）时强制重挂载当前页以刷新数据。
  const routeRevision = String(vaultSync.revision);

  useEffect(() => {
    const onKeyDown = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    setSearchOpen(false);
    setSelectedDocumentId(null);
    setReaderContext(null);
  }, [location.pathname]);

  const openDocument = useCallback((documentOrId) => {
    const id =
      typeof documentOrId === "string"
        ? documentOrId
        : documentOrId?.id ?? documentOrId?.relativePath;
    if (id) {
      setSelectedDocumentId(id);
      setReaderContext(
        typeof documentOrId === "object" ? documentOrId.readerContext || null : null,
      );
    }
  }, []);

  const appContext = useMemo(
    () => ({
      navigate,
      openDocument,
      openSearch: () => setSearchOpen(true),
    }),
    [navigate, openDocument],
  );

  return (
    <>
      <AppShell onOpenSearch={appContext.openSearch} sync={vaultSync}>
        <Routes key={routeRevision}>
          <Route path="/" element={<OverviewPage onOpenDocument={openDocument} />} />
          <Route path="/graph" element={<GraphPage onOpenDocument={openDocument} />} />
          <Route path="/books" element={<BooksPage onOpenDocument={openDocument} />} />
          <Route path="/books/:bookId" element={<BooksPage onOpenDocument={openDocument} />} />
          <Route path="/daily-hot" element={<DailyHotPage />} />
          {localWorkbench ? (
            <Route
              path="/career"
              element={
                <CareerPage
                  onOpenDocument={openDocument}
                  syncRevision={vaultSync.revision}
                />
              }
            />
          ) : null}
          {localWorkbench ? (
            <Route
              path="/stocks"
              element={
                <StockWatchlistPage
                  onOpenDocument={openDocument}
                  syncRevision={vaultSync.revision}
                />
              }
            />
          ) : null}
          <Route
            path="/topics"
            element={<TopicsPage onOpenDocument={openDocument} />}
          />
          <Route path="/prompts" element={<PromptsLibraryPage />} />
          <Route path="/system" element={<SystemPage />} />
          <Route path="*" element={<Navigate replace to="/" />} />
        </Routes>
      </AppShell>

      <SearchPalette
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onOpenDocument={(document) => {
          openDocument(document);
          setSearchOpen(false);
        }}
      />

      <DocumentDrawer
        documentId={selectedDocumentId}
        onNavigateDocument={openDocument}
        onClose={() => {
          setSelectedDocumentId(null);
          setReaderContext(null);
        }}
        readingContext={readerContext}
      />
    </>
  );
}
