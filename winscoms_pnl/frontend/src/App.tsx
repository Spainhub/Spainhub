import { Route, Routes } from "react-router-dom";
import Layout from "./components/Layout";
import { RequireAuth, RequireOrg, RequirePlatformAdmin } from "./components/RequireAuth";
import AdminPage from "./features/admin/AdminPage";
import ConnectionsPage from "./features/connections/ConnectionsPage";
import Dashboard from "./features/dashboard/Dashboard";
import ExpensesPage from "./features/expenses/ExpensesPage";
import LoginPage from "./features/LoginPage";
import PnlPage from "./features/pnl/PnlPage";
import SettingsPage from "./features/settings/SettingsPage";
import { EmptyState } from "./components/ui";

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth><Layout /></RequireAuth>}>
        <Route index element={<RequireOrg><Dashboard /></RequireOrg>} />
        <Route path="pnl" element={<RequireOrg><PnlPage /></RequireOrg>} />
        <Route path="connections" element={<RequireOrg><ConnectionsPage /></RequireOrg>} />
        <Route path="expenses" element={<RequireOrg><ExpensesPage /></RequireOrg>} />
        <Route path="settings" element={<RequireOrg><SettingsPage /></RequireOrg>} />
        <Route path="admin" element={<RequirePlatformAdmin><AdminPage /></RequirePlatformAdmin>} />
        <Route path="*" element={<EmptyState title="Страница не найдена" />} />
      </Route>
    </Routes>
  );
}
